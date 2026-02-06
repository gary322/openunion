import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type ExecResult = { stdout: string; stderr: string };

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function normalizeEnv(envRaw: string): 'staging' | 'production' {
  const env = String(envRaw ?? '').trim().toLowerCase();
  if (env === 'staging') return 'staging';
  if (env === 'prod' || env === 'production') return 'production';
  throw new Error(`invalid_env:${envRaw} (expected staging|production|prod)`);
}

function prefixForEnv(env: 'staging' | 'production'): string {
  return env === 'staging' ? 'proofwork-staging' : 'proofwork-prod';
}

function looksLikeStripeSecretKey(v: string): boolean {
  return v.startsWith('sk_test_') || v.startsWith('sk_live_');
}

function looksLikeStripeWebhookSecret(v: string): boolean {
  return v.startsWith('whsec_') && v.length >= 10;
}

async function execFile(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string>; allowFailure?: boolean; redactCmd?: boolean }
): Promise<ExecResult> {
  const cwd = opts?.cwd;
  const env = { ...process.env, ...(opts?.env ?? {}) } as Record<string, string>;
  const allowFailure = opts?.allowFailure ?? false;

  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !allowFailure) {
        const rendered = opts?.redactCmd ? `${cmd} <redacted args>` : `${cmd} ${args.join(' ')}`.trim();
        reject(new Error(`command_failed:${rendered}:exit_${code}\n${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function awsJson(region: string, args: string[]): Promise<any> {
  const out = await execFile('aws', [...args, '--region', region, '--output', 'json'], { redactCmd: true });
  const s = out.stdout.trim();
  return s ? JSON.parse(s) : null;
}

async function awsText(region: string, args: string[]): Promise<string> {
  const out = await execFile('aws', [...args, '--region', region, '--output', 'text'], { redactCmd: true });
  return out.stdout.trim();
}

async function writeTempSecretFile(value: string): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'proofwork-stripe-'));
  const file = join(dir, 'secret.txt');
  await writeFile(file, value, { mode: 0o600 });
  return { dir, file };
}

async function putSecretValue(input: { region: string; secretId: string; value: string }) {
  const { dir, file } = await writeTempSecretFile(input.value);
  try {
    await execFile('aws', ['secretsmanager', 'put-secret-value', '--region', input.region, '--secret-id', input.secretId, '--secret-string', `file://${file}`], {
      redactCmd: true,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function describeSecretArn(input: { region: string; secretId: string }): Promise<string> {
  const arn = await awsText(input.region, ['secretsmanager', 'describe-secret', '--secret-id', input.secretId, '--query', 'ARN']);
  if (!arn) throw new Error(`secret_missing:${input.secretId}`);
  return arn;
}

function uniqByName(entries: Array<{ name: string; valueFrom: string }>) {
  const seen = new Set<string>();
  const out: Array<{ name: string; valueFrom: string }> = [];
  for (const e of entries) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    out.push(e);
  }
  return out;
}

async function getServiceTaskDefArn(input: { region: string; cluster: string; service: string }): Promise<string> {
  const td = await awsText(input.region, [
    'ecs',
    'describe-services',
    '--cluster',
    input.cluster,
    '--services',
    input.service,
    '--query',
    'services[0].taskDefinition',
  ]);
  if (!td || td === 'None') throw new Error(`ecs_task_definition_not_found:${input.cluster}:${input.service}`);
  return td;
}

async function ensureStripeSecretsInjected(input: {
  region: string;
  cluster: string;
  service: string;
  stripeSecretKeyArn: string;
  stripeWebhookSecretArn: string;
}): Promise<{ taskDefinitionArn: string; changed: boolean }> {
  const currentTdArn = await getServiceTaskDefArn({ region: input.region, cluster: input.cluster, service: input.service });
  const td = await awsJson(input.region, ['ecs', 'describe-task-definition', '--task-definition', currentTdArn, '--query', 'taskDefinition']);
  if (!td) throw new Error('ecs_describe_task_definition_empty');

  const containers: any[] = Array.isArray(td.containerDefinitions) ? td.containerDefinitions : [];
  const apiContainer = containers.find((c) => c?.name === 'api');
  if (!apiContainer) throw new Error('ecs_task_definition_missing_api_container');

  const secrets: Array<{ name: string; valueFrom: string }> = Array.isArray(apiContainer.secrets) ? apiContainer.secrets : [];
  const want = uniqByName([
    ...secrets.filter((s) => s?.name !== 'STRIPE_SECRET_KEY' && s?.name !== 'STRIPE_WEBHOOK_SECRET'),
    { name: 'STRIPE_SECRET_KEY', valueFrom: input.stripeSecretKeyArn },
    { name: 'STRIPE_WEBHOOK_SECRET', valueFrom: input.stripeWebhookSecretArn },
  ]);

  const already =
    secrets.some((s) => s?.name === 'STRIPE_SECRET_KEY' && String(s.valueFrom) === input.stripeSecretKeyArn) &&
    secrets.some((s) => s?.name === 'STRIPE_WEBHOOK_SECRET' && String(s.valueFrom) === input.stripeWebhookSecretArn);

  if (already) {
    return { taskDefinitionArn: currentTdArn, changed: false };
  }

  const patched = { ...td };
  delete (patched as any).taskDefinitionArn;
  delete (patched as any).revision;
  delete (patched as any).status;
  delete (patched as any).requiresAttributes;
  delete (patched as any).compatibilities;
  delete (patched as any).registeredAt;
  delete (patched as any).registeredBy;

  patched.containerDefinitions = containers.map((c) => {
    if (c?.name !== 'api') return c;
    return { ...c, secrets: want };
  });

  const tmpDir = await mkdtemp(join(tmpdir(), 'proofwork-ecs-td-'));
  const tmpFile = join(tmpDir, 'taskdef.json');
  await writeFile(tmpFile, JSON.stringify(patched), { mode: 0o600 });
  try {
    const newTdArn = await awsText(input.region, [
      'ecs',
      'register-task-definition',
      '--cli-input-json',
      `file://${tmpFile}`,
      '--query',
      'taskDefinition.taskDefinitionArn',
    ]);
    if (!newTdArn) throw new Error('ecs_register_task_definition_failed');

    await execFile('aws', ['ecs', 'update-service', '--region', input.region, '--cluster', input.cluster, '--service', input.service, '--task-definition', newTdArn], {
      redactCmd: true,
    });
    await execFile('aws', ['ecs', 'wait', 'services-stable', '--region', input.region, '--cluster', input.cluster, '--services', input.service], {
      redactCmd: true,
    });

    return { taskDefinitionArn: newTdArn, changed: true };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function forceServiceRedeploy(input: { region: string; cluster: string; service: string }) {
  await execFile('aws', ['ecs', 'update-service', '--region', input.region, '--cluster', input.cluster, '--service', input.service, '--force-new-deployment'], {
    redactCmd: true,
  });
  await execFile('aws', ['ecs', 'wait', 'services-stable', '--region', input.region, '--cluster', input.cluster, '--services', input.service], {
    redactCmd: true,
  });
}

async function inferPublicBaseUrl(input: { region: string; taskDefinitionArn: string }): Promise<string | undefined> {
  const env = await awsJson(input.region, [
    'ecs',
    'describe-task-definition',
    '--task-definition',
    input.taskDefinitionArn,
    '--query',
    'taskDefinition.containerDefinitions[?name==`api`].environment',
  ]);
  const entries = Array.isArray(env?.[0]) ? env[0] : Array.isArray(env) ? env : [];
  const found = entries.find((e: any) => String(e?.name ?? '') === 'PUBLIC_BASE_URL');
  const v = String(found?.value ?? '').trim();
  return v || undefined;
}

async function getSecretCurrentValue(input: { region: string; secretId: string }): Promise<string> {
  const out = await awsText(input.region, ['secretsmanager', 'get-secret-value', '--secret-id', input.secretId, '--query', 'SecretString']);
  const v = String(out ?? '').trim();
  if (!v) throw new Error(`secret_empty_or_missing_current_version:${input.secretId}`);
  return v;
}

async function runStripeSmoke(input: {
  baseUrl: string;
  webhookSecret: string;
  buyerEmail?: string;
  buyerPassword?: string;
  topupCents?: number;
}) {
  const env: Record<string, string> = {
    ...process.env,
    BASE_URL: input.baseUrl,
    SMOKE_STRIPE_WEBHOOK_SECRET: input.webhookSecret,
  };
  if (input.buyerEmail) env.SMOKE_BUYER_EMAIL = input.buyerEmail;
  if (input.buyerPassword) env.SMOKE_BUYER_PASSWORD = input.buyerPassword;
  if (input.topupCents !== undefined) env.SMOKE_TOPUP_CENTS = String(input.topupCents);

  // Avoid printing secrets; smoke output is safe (session IDs, URLs).
  await execFile('npm', ['run', 'smoke:stripe:remote'], { cwd: process.cwd(), env, redactCmd: true });
}

async function main() {
  const env = normalizeEnv(argValue('--env') ?? argValue('--environment') ?? 'staging');
  const region = String(argValue('--region') ?? process.env.AWS_REGION ?? 'us-east-1').trim();
  const prefix = prefixForEnv(env);

  const cluster = String(argValue('--cluster') ?? `${prefix}-cluster`).trim();
  const service = String(argValue('--service') ?? `${prefix}-api`).trim();

  const stripeSecretId = `${prefix}/STRIPE_SECRET_KEY`;
  const webhookSecretId = `${prefix}/STRIPE_WEBHOOK_SECRET`;

  const stripeSecretKeyFile = argValue('--stripe-secret-key-file');
  const stripeWebhookSecretFile = argValue('--stripe-webhook-secret-file');
  const generateWebhookSecret = hasFlag('--generate-webhook-secret');

  const skipPutSecrets = hasFlag('--skip-put-secrets');
  const skipEcsPatch = hasFlag('--skip-ecs-patch');
  const skipRestart = hasFlag('--skip-restart');
  const skipSmoke = hasFlag('--skip-smoke');

  const buyerEmail = argValue('--buyer-email');
  const buyerPassword = argValue('--buyer-password');
  const topupCentsRaw = argValue('--topup-cents');
  const topupCents = topupCentsRaw ? Number(topupCentsRaw) : undefined;
  if (topupCents !== undefined && (!Number.isFinite(topupCents) || topupCents <= 0)) {
    throw new Error('--topup-cents must be a positive number');
  }

  console.log(`[stripe-ops] env=${env} region=${region} cluster=${cluster} service=${service}`);

  if (!skipPutSecrets) {
    let stripeSecretKeyValue: string | undefined;
    if (stripeSecretKeyFile) {
      stripeSecretKeyValue = (await (await import('node:fs/promises')).readFile(stripeSecretKeyFile, 'utf8')).trim();
    }
    if (stripeSecretKeyValue !== undefined) {
      if (!looksLikeStripeSecretKey(stripeSecretKeyValue)) throw new Error('stripe_secret_key_invalid_format');
      await putSecretValue({ region, secretId: stripeSecretId, value: stripeSecretKeyValue });
      console.log(`[stripe-ops] updated secret: ${stripeSecretId} (len=${stripeSecretKeyValue.length})`);
    } else {
      console.log(`[stripe-ops] skipped updating ${stripeSecretId} (no --stripe-secret-key-file)`);
    }

    let stripeWebhookSecretValue: string | undefined;
    if (stripeWebhookSecretFile) {
      stripeWebhookSecretValue = (await (await import('node:fs/promises')).readFile(stripeWebhookSecretFile, 'utf8')).trim();
    } else if (generateWebhookSecret) {
      stripeWebhookSecretValue = `whsec_${randomBytes(16).toString('hex')}`;
    }

    if (stripeWebhookSecretValue !== undefined) {
      if (!looksLikeStripeWebhookSecret(stripeWebhookSecretValue)) throw new Error('stripe_webhook_secret_invalid_format');
      await putSecretValue({ region, secretId: webhookSecretId, value: stripeWebhookSecretValue });
      console.log(`[stripe-ops] updated secret: ${webhookSecretId} (len=${stripeWebhookSecretValue.length})`);
    } else {
      console.log(
        `[stripe-ops] skipped updating ${webhookSecretId} (no --stripe-webhook-secret-file and no --generate-webhook-secret)`
      );
    }
  }

  const stripeSecretKeyArn = await describeSecretArn({ region, secretId: stripeSecretId });
  const stripeWebhookSecretArn = await describeSecretArn({ region, secretId: webhookSecretId });

  let taskDefinitionArn = await getServiceTaskDefArn({ region, cluster, service });
  if (!skipEcsPatch) {
    const patch = await ensureStripeSecretsInjected({ region, cluster, service, stripeSecretKeyArn, stripeWebhookSecretArn });
    taskDefinitionArn = patch.taskDefinitionArn;
    console.log(`[stripe-ops] ecs_secrets_injected changed=${patch.changed} task_definition=${taskDefinitionArn}`);
  }

  if (!skipRestart) {
    await forceServiceRedeploy({ region, cluster, service });
    console.log('[stripe-ops] ecs_service_redeployed');
  }

  if (!skipSmoke) {
    const baseUrl =
      String(argValue('--base-url') ?? '').trim() ||
      (await inferPublicBaseUrl({ region, taskDefinitionArn })) ||
      (env === 'staging'
        ? 'http://proofwork-staging-alb-1837483526.us-east-1.elb.amazonaws.com'
        : 'http://proofwork-prod-alb-1387116481.us-east-1.elb.amazonaws.com');

    const webhookSecret = await getSecretCurrentValue({ region, secretId: webhookSecretId });
    await runStripeSmoke({ baseUrl, webhookSecret, buyerEmail: buyerEmail || undefined, buyerPassword: buyerPassword || undefined, topupCents });
    console.log('[stripe-ops] smoke_ok');
  }
}

main().catch((err) => {
  console.error('[stripe-ops] failed', err);
  process.exitCode = 1;
});

