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

async function writeTempJsonFile(obj: any, prefix: string): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const file = join(dir, 'taskdef.json');
  await writeFile(file, JSON.stringify(obj), { mode: 0o600 });
  return { dir, file };
}

function uniqEnv(entries: Array<{ name: string; value: string }>) {
  const seen = new Set<string>();
  const out: Array<{ name: string; value: string }> = [];
  for (const e of entries) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    out.push(e);
  }
  return out;
}

async function getServiceJson(input: { region: string; cluster: string; service: string }): Promise<any> {
  const svc = await awsJson(input.region, [
    'ecs',
    'describe-services',
    '--cluster',
    input.cluster,
    '--services',
    input.service,
    '--query',
    'services[0]',
  ]);
  return svc ?? null;
}

async function registerGithubIngestTaskDef(input: {
  region: string;
  prefix: string;
  templateTaskDefArn: string;
  command: string[];
  environment: Array<{ name: string; value: string }>;
}) {
  const td = await awsJson(input.region, [
    'ecs',
    'describe-task-definition',
    '--task-definition',
    input.templateTaskDefArn,
    '--query',
    'taskDefinition',
  ]);
  if (!td) throw new Error('ecs_describe_task_definition_empty');

  const patched = { ...td };
  delete (patched as any).taskDefinitionArn;
  delete (patched as any).revision;
  delete (patched as any).status;
  delete (patched as any).requiresAttributes;
  delete (patched as any).compatibilities;
  delete (patched as any).registeredAt;
  delete (patched as any).registeredBy;

  patched.family = `${input.prefix}-github-ingest`;

  const containers: any[] = Array.isArray(patched.containerDefinitions) ? patched.containerDefinitions : [];
  if (containers.length !== 1) throw new Error('expected_single_container_taskdef');
  const c = { ...containers[0] };
  c.name = 'github-ingest';
  c.command = input.command;

  const env: Array<{ name: string; value: string }> = Array.isArray(c.environment) ? c.environment : [];
  const without = env.filter((e) => !['RETENTION_HEALTH_PORT', 'GITHUB_INGEST_HEALTH_PORT'].includes(String(e?.name ?? '')));
  c.environment = uniqEnv([
    ...without,
    { name: 'GITHUB_INGEST_HEALTH_PORT', value: '9106' },
    ...input.environment,
  ]);

  // Update log group/stream for clarity.
  if (c.logConfiguration?.options) {
    c.logConfiguration = {
      ...c.logConfiguration,
      options: {
        ...c.logConfiguration.options,
        'awslogs-group': `/ecs/${input.prefix}/github-ingest`,
        'awslogs-stream-prefix': 'github-ingest',
      },
    };
  }

  // Health check: verify the worker health server is reachable.
  c.healthCheck = {
    command: ['CMD-SHELL', 'wget -q -O - http://127.0.0.1:$GITHUB_INGEST_HEALTH_PORT/health >/dev/null 2>&1 || exit 1'],
    interval: 30,
    timeout: 5,
    retries: 3,
    startPeriod: 30,
  };

  patched.containerDefinitions = [c];

  const { dir, file } = await writeTempJsonFile(patched, 'proofwork-github-ingest-');
  try {
    const arn = await awsText(input.region, [
      'ecs',
      'register-task-definition',
      '--cli-input-json',
      `file://${file}`,
      '--query',
      'taskDefinition.taskDefinitionArn',
    ]);
    if (!arn) throw new Error('ecs_register_task_definition_failed');
    return arn;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const env = normalizeEnv(argValue('--env') ?? argValue('--environment') ?? 'staging');
  const region = String(argValue('--region') ?? process.env.AWS_REGION ?? 'us-east-1').trim();
  const prefix = prefixForEnv(env);

  const cluster = String(argValue('--cluster') ?? `${prefix}-cluster`).trim();
  const service = String(argValue('--service') ?? `${prefix}-github-ingest`).trim();
  const templateService = String(argValue('--template-service') ?? `${prefix}-retention`).trim();

  console.log(`[github-ingest-enable] env=${env} region=${region} cluster=${cluster} service=${service} template=${templateService}`);

  const templateSvc = await getServiceJson({ region, cluster, service: templateService });
  const templateTdArn = String(templateSvc?.taskDefinition ?? '').trim();
  const netCfg = templateSvc?.networkConfiguration;
  if (!templateTdArn) throw new Error('template_service_missing_task_definition');
  if (!netCfg) throw new Error('template_service_missing_network_configuration');

  const newTdArn = await registerGithubIngestTaskDef({
    region,
    prefix,
    templateTaskDefArn: templateTdArn,
    command: ['node', 'dist/workers/github-ingest-runner.js'],
    environment: [
      { name: 'GITHUB_INGEST_SOURCE_ID', value: 'platform' },
      { name: 'GITHUB_INGEST_SOURCE_KIND', value: 'hybrid' },
      { name: 'GITHUB_INGEST_POLL_MS', value: '60000' },
      { name: 'GITHUB_INGEST_ARCHIVE_POLL_MS', value: '300000' },
      { name: 'GITHUB_EVENTS_RAW_TTL_DAYS', value: '14' },
      { name: 'GITHUB_EVENTS_RAW_PRUNE_LIMIT', value: '10000' },
      { name: 'GITHUB_EVENTS_RAW_PRUNE_INTERVAL_MS', value: String(60 * 60_000) },
      { name: 'GITHUB_EVENTS_API_BASE_URL', value: 'https://api.github.com' },
      { name: 'GITHUB_GH_ARCHIVE_BASE_URL', value: 'https://data.gharchive.org' },
    ],
  });

  const existing = await getServiceJson({ region, cluster, service });
  const status = String(existing?.status ?? '').trim();
  const hasActive = status === 'ACTIVE' && String(existing?.serviceName ?? '').trim();

  if (!hasActive) {
    await execFile(
      'aws',
      [
        'ecs',
        'create-service',
        '--region',
        region,
        '--cluster',
        cluster,
        '--service-name',
        service,
        '--task-definition',
        newTdArn,
        '--desired-count',
        '1',
        '--launch-type',
        'FARGATE',
        '--network-configuration',
        JSON.stringify(netCfg),
      ],
      { redactCmd: true }
    );
    console.log(`[github-ingest-enable] service_created task_definition=${newTdArn}`);
  } else {
    await execFile(
      'aws',
      [
        'ecs',
        'update-service',
        '--region',
        region,
        '--cluster',
        cluster,
        '--service',
        service,
        '--task-definition',
        newTdArn,
        '--desired-count',
        '1',
      ],
      { redactCmd: true }
    );
    console.log(`[github-ingest-enable] service_updated task_definition=${newTdArn}`);
  }

  await execFile('aws', ['ecs', 'wait', 'services-stable', '--region', region, '--cluster', cluster, '--services', service], {
    redactCmd: true,
  });

  console.log('[github-ingest-enable] ok');
}

main().catch((err) => {
  console.error('[github-ingest-enable] failed', err);
  process.exitCode = 1;
});

