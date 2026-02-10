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

async function awsText(region: string, args: string[]): Promise<string> {
  const out = await execFile('aws', [...args, '--region', region, '--output', 'text'], { redactCmd: true });
  return out.stdout.trim();
}

async function awsJson(region: string, args: string[]): Promise<any> {
  const out = await execFile('aws', [...args, '--region', region, '--output', 'json'], { redactCmd: true });
  const s = out.stdout.trim();
  return s ? JSON.parse(s) : null;
}

async function writeTempSecretFile(value: string): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'proofwork-stripe-webhook-'));
  const file = join(dir, 'secret.txt');
  await writeFile(file, value, { mode: 0o600 });
  return { dir, file };
}

async function putSecretValue(input: { region: string; secretId: string; value: string }) {
  const { dir, file } = await writeTempSecretFile(input.value);
  try {
    await execFile(
      'aws',
      ['secretsmanager', 'put-secret-value', '--region', input.region, '--secret-id', input.secretId, '--secret-string', `file://${file}`],
      { redactCmd: true }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function getSecretCurrentValue(input: { region: string; secretId: string }): Promise<string> {
  const out = await awsText(input.region, ['secretsmanager', 'get-secret-value', '--secret-id', input.secretId, '--query', 'SecretString']);
  const v = String(out ?? '').trim();
  if (!v) throw new Error(`secret_empty_or_missing_current_version:${input.secretId}`);
  return v;
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

async function forceServiceRedeploy(input: { region: string; cluster: string; service: string }) {
  await execFile('aws', ['ecs', 'update-service', '--region', input.region, '--cluster', input.cluster, '--service', input.service, '--force-new-deployment'], {
    redactCmd: true,
  });
  await execFile('aws', ['ecs', 'wait', 'services-stable', '--region', input.region, '--cluster', input.cluster, '--services', input.service], {
    redactCmd: true,
  });
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/$/, '');
}

function mustHttpsUrl(s: string): string {
  const u = new URL(s);
  if (u.protocol !== 'https:') throw new Error(`public_base_url_not_https:${s}`);
  return u.toString().replace(/\/$/, '');
}

async function stripeRequest(input: {
  secretKey: string;
  method: 'GET' | 'POST';
  path: string;
  body?: URLSearchParams;
}): Promise<any> {
  const url = `https://api.stripe.com${input.path}`;
  const resp = await fetch(url, {
    method: input.method,
    headers: {
      Authorization: `Bearer ${input.secretKey}`,
      Accept: 'application/json',
      ...(input.method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: input.method === 'POST' ? input.body?.toString() : undefined,
  });
  const text = await resp.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!resp.ok) {
    const msg = String(json?.error?.message ?? text ?? '').slice(0, 300);
    throw new Error(`stripe_api_failed:${input.method}:${input.path}:${resp.status}:${msg}`);
  }
  return json;
}

async function stripeListWebhookEndpoints(input: { secretKey: string; limit?: number }): Promise<any[]> {
  const lim = Math.max(1, Math.min(100, Math.floor(Number(input.limit ?? 100))));
  const json = await stripeRequest({ secretKey: input.secretKey, method: 'GET', path: `/v1/webhook_endpoints?limit=${lim}` });
  return Array.isArray(json?.data) ? json.data : [];
}

async function stripeCreateWebhookEndpoint(input: {
  secretKey: string;
  url: string;
  enabledEvents: string[];
  description?: string;
}): Promise<{ id: string; secret: string; status: string; url: string }> {
  const body = new URLSearchParams();
  body.set('url', input.url);
  if (input.description) body.set('description', input.description);
  for (const evt of input.enabledEvents) body.append('enabled_events[]', evt);
  const json = await stripeRequest({ secretKey: input.secretKey, method: 'POST', path: '/v1/webhook_endpoints', body });
  const id = String(json?.id ?? '').trim();
  const secret = String(json?.secret ?? '').trim();
  const status = String(json?.status ?? '').trim();
  const url = String(json?.url ?? '').trim();
  if (!id || !secret || !url) throw new Error('stripe_create_webhook_endpoint_invalid_response');
  return { id, secret, status, url };
}

async function stripeDisableWebhookEndpoint(input: { secretKey: string; id: string }) {
  const body = new URLSearchParams();
  body.set('disabled', 'true');
  await stripeRequest({ secretKey: input.secretKey, method: 'POST', path: `/v1/webhook_endpoints/${encodeURIComponent(input.id)}`, body });
}

async function runDeterministicStripeSmoke(input: { baseUrl: string; webhookSecret: string }) {
  const env: Record<string, string> = {
    ...process.env,
    BASE_URL: input.baseUrl,
    SMOKE_STRIPE_WEBHOOK_SECRET: input.webhookSecret,
  };
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

  const skipSmoke = hasFlag('--skip-smoke');
  const skipDisable = hasFlag('--skip-disable-duplicates');

  console.log(`[stripe-webhook-rotate] env=${env} region=${region} cluster=${cluster} service=${service}`);

  const taskDefinitionArn = await getServiceTaskDefArn({ region, cluster, service });
  const publicBaseUrlRaw =
    String(argValue('--public-base-url') ?? '').trim() ||
    (await inferPublicBaseUrl({ region, taskDefinitionArn })) ||
    '';
  const publicBaseUrl = mustHttpsUrl(stripTrailingSlash(publicBaseUrlRaw));
  const webhookUrl = `${publicBaseUrl}/api/webhooks/stripe`;

  const stripeSecretKey = await getSecretCurrentValue({ region, secretId: stripeSecretId });

  console.log(`[stripe-webhook-rotate] creating Stripe webhook endpoint url=${webhookUrl}`);
  const created = await stripeCreateWebhookEndpoint({
    secretKey: stripeSecretKey,
    url: webhookUrl,
    enabledEvents: ['checkout.session.completed'],
    description: `proofwork ${env} webhook`,
  });
  if (!created.secret.startsWith('whsec_')) throw new Error('stripe_webhook_secret_unexpected_format');
  console.log(`[stripe-webhook-rotate] created webhook endpoint id=${created.id} status=${created.status}`);

  await putSecretValue({ region, secretId: webhookSecretId, value: created.secret });
  console.log(`[stripe-webhook-rotate] updated secret: ${webhookSecretId} (len=${created.secret.length})`);

  await forceServiceRedeploy({ region, cluster, service });
  console.log('[stripe-webhook-rotate] api_redeployed');

  if (!skipSmoke) {
    await runDeterministicStripeSmoke({ baseUrl: publicBaseUrl, webhookSecret: created.secret });
    console.log('[stripe-webhook-rotate] deterministic_smoke_ok');
  }

  if (!skipDisable) {
    const endpoints = await stripeListWebhookEndpoints({ secretKey: stripeSecretKey, limit: 100 });
    const dupes = endpoints.filter((e) => String(e?.url ?? '').trim() === webhookUrl && String(e?.id ?? '').trim() !== created.id);
    const enabledDupes = dupes.filter((e) => String(e?.status ?? '').trim() === 'enabled');
    for (const e of enabledDupes) {
      const id = String(e?.id ?? '').trim();
      if (!id) continue;
      await stripeDisableWebhookEndpoint({ secretKey: stripeSecretKey, id });
    }
    console.log(`[stripe-webhook-rotate] duplicates_disabled total=${dupes.length} enabled_disabled=${enabledDupes.length}`);
  }

  console.log('[stripe-webhook-rotate] ok');
}

main().catch((err) => {
  console.error('[stripe-webhook-rotate] failed', err);
  process.exitCode = 1;
});

