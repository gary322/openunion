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

function envLabel(env: 'staging' | 'production'): string {
  return env === 'staging' ? 'staging' : 'prod';
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
  const file = join(dir, 'tmp.json');
  await writeFile(file, JSON.stringify(obj), { mode: 0o600 });
  return { dir, file };
}

async function ensureCloudWatchLogGroup(input: { region: string; logGroupName: string; retentionDays: number }) {
  const res = await awsJson(input.region, ['logs', 'describe-log-groups', '--log-group-name-prefix', input.logGroupName]);
  const groups: any[] = Array.isArray(res?.logGroups) ? res.logGroups : [];
  const exists = groups.some((g) => String(g?.logGroupName ?? '') === input.logGroupName);

  if (!exists) {
    await execFile('aws', ['logs', 'create-log-group', '--region', input.region, '--log-group-name', input.logGroupName], {
      allowFailure: true,
      redactCmd: true,
    });
  }

  await execFile(
    'aws',
    ['logs', 'put-retention-policy', '--region', input.region, '--log-group-name', input.logGroupName, '--retention-in-days', String(input.retentionDays)],
    { redactCmd: true }
  );
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

function renderCloudWatchPublishPolicy(topicArn: string) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AllowCloudWatchToPublish',
        Effect: 'Allow',
        Principal: { Service: 'cloudwatch.amazonaws.com' },
        Action: 'sns:Publish',
        Resource: topicArn,
      },
    ],
  };
}

async function ensureSnsTopic(input: { region: string; name: string }): Promise<string> {
  const arn = await awsText(input.region, ['sns', 'create-topic', '--name', input.name, '--query', 'TopicArn']);
  if (!arn) throw new Error('sns_create_topic_failed');

  const policy = renderCloudWatchPublishPolicy(arn);
  await execFile(
    'aws',
    ['sns', 'set-topic-attributes', '--region', input.region, '--topic-arn', arn, '--attribute-name', 'Policy', '--attribute-value', JSON.stringify(policy)],
    { redactCmd: true }
  );

  return arn;
}

function sanitizeMetricAlarmForPut(alarm: any, topicArn: string) {
  const allowed = new Set([
    'AlarmName',
    'AlarmDescription',
    'ActionsEnabled',
    'OKActions',
    'AlarmActions',
    'InsufficientDataActions',
    'MetricName',
    'Namespace',
    'Statistic',
    'ExtendedStatistic',
    'Dimensions',
    'Period',
    'Unit',
    'EvaluationPeriods',
    'DatapointsToAlarm',
    'Threshold',
    'ComparisonOperator',
    'TreatMissingData',
    'EvaluateLowSampleCountPercentile',
    'Metrics',
    'Tags',
  ]);

  const out: any = {};
  for (const [k, v] of Object.entries(alarm ?? {})) {
    if (!allowed.has(k)) continue;
    out[k] = v;
  }

  out.OKActions = [topicArn];
  out.AlarmActions = [topicArn];

  return out;
}

async function ensureCloudWatchAlarmsWired(input: { region: string; alarmNamePrefix: string; topicArn: string }) {
  const alarms = await awsJson(input.region, [
    'cloudwatch',
    'describe-alarms',
    '--alarm-name-prefix',
    input.alarmNamePrefix,
    '--query',
    'MetricAlarms[].AlarmName',
  ]);
  const names: string[] = Array.isArray(alarms) ? alarms.map((s) => String(s ?? '').trim()).filter(Boolean) : [];
  if (!names.length) return;

  for (const name of names) {
    const alarm = await awsJson(input.region, [
      'cloudwatch',
      'describe-alarms',
      '--alarm-names',
      name,
      '--query',
      'MetricAlarms[0]',
    ]);
    if (!alarm) continue;
    const currentActions: string[] = Array.isArray(alarm?.AlarmActions) ? alarm.AlarmActions : [];
    const already = currentActions.includes(input.topicArn);
    if (already) continue;

    const patched = sanitizeMetricAlarmForPut(alarm, input.topicArn);
    const { dir, file } = await writeTempJsonFile(patched, 'proofwork-alarm-');
    try {
      await execFile('aws', ['cloudwatch', 'put-metric-alarm', '--region', input.region, '--cli-input-json', `file://${file}`], {
        redactCmd: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

async function ensureSqsQueue(input: { region: string; queueName: string }): Promise<{ queueUrl: string; queueArn: string }> {
  let url = '';
  try {
    url = await awsText(input.region, ['sqs', 'get-queue-url', '--queue-name', input.queueName, '--query', 'QueueUrl']);
  } catch {
    // ignore
  }
  if (!url) {
    url = await awsText(input.region, ['sqs', 'create-queue', '--queue-name', input.queueName, '--query', 'QueueUrl']);
  }
  if (!url) throw new Error('sqs_queue_url_missing');

  const arn = await awsText(input.region, [
    'sqs',
    'get-queue-attributes',
    '--queue-url',
    url,
    '--attribute-names',
    'QueueArn',
    '--query',
    'Attributes.QueueArn',
  ]);
  if (!arn) throw new Error('sqs_queue_arn_missing');

  return { queueUrl: url, queueArn: arn };
}

function renderSqsAllowSnsPolicy(input: { queueArn: string; topicArn: string }) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AllowSnsPublish',
        Effect: 'Allow',
        Principal: { Service: 'sns.amazonaws.com' },
        Action: 'sqs:SendMessage',
        Resource: input.queueArn,
        Condition: { ArnEquals: { 'aws:SourceArn': input.topicArn } },
      },
    ],
  };
}

async function ensureSqsSubscription(input: { region: string; topicArn: string; queueArn: string; queueUrl: string }) {
  const policy = renderSqsAllowSnsPolicy({ queueArn: input.queueArn, topicArn: input.topicArn });
  const { dir, file } = await writeTempJsonFile({ QueueUrl: input.queueUrl, Attributes: { Policy: JSON.stringify(policy) } }, 'proofwork-sqs-policy-');
  try {
    await execFile('aws', ['sqs', 'set-queue-attributes', '--region', input.region, '--cli-input-json', `file://${file}`], { redactCmd: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const subs = await awsJson(input.region, ['sns', 'list-subscriptions-by-topic', '--topic-arn', input.topicArn, '--query', 'Subscriptions']);
  const arr: any[] = Array.isArray(subs) ? subs : [];
  const exists = arr.some((s) => String(s?.Endpoint ?? '') === input.queueArn && String(s?.Protocol ?? '') === 'sqs');
  if (exists) return;

  await execFile(
    'aws',
    [
      'sns',
      'subscribe',
      '--region',
      input.region,
      '--topic-arn',
      input.topicArn,
      '--protocol',
      'sqs',
      '--notification-endpoint',
      input.queueArn,
      '--return-subscription-arn',
    ],
    { redactCmd: true }
  );
}

function ensureSqsReadPermissionsInPolicyDoc(input: { doc: any; queueArn: string }) {
  const doc = input.doc ?? {};
  const stmts: any[] = Array.isArray(doc.Statement) ? doc.Statement : [];
  const filtered = stmts.filter((s) => String(s?.Sid ?? '') !== 'AllowAlarmInboxSqs');

  const next = {
    Version: String(doc.Version ?? '2012-10-17'),
    Statement: [
      ...filtered,
      {
        Sid: 'AllowAlarmInboxSqs',
        Effect: 'Allow',
        Action: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl', 'sqs:ChangeMessageVisibility'],
        Resource: [input.queueArn],
      },
    ],
  };

  return next;
}

async function ensureIamRoleCanDrainQueue(input: { region: string; roleName: string; policyName: string; queueArn: string }) {
  const doc = await awsJson(input.region, [
    'iam',
    'get-role-policy',
    '--role-name',
    input.roleName,
    '--policy-name',
    input.policyName,
    '--query',
    'PolicyDocument',
  ]);
  if (!doc) throw new Error(`iam_get_role_policy_failed:${input.roleName}:${input.policyName}`);

  const patched = ensureSqsReadPermissionsInPolicyDoc({ doc, queueArn: input.queueArn });
  const { dir, file } = await writeTempJsonFile(patched, 'proofwork-iam-policy-');
  try {
    await execFile(
      'aws',
      ['iam', 'put-role-policy', '--region', input.region, '--role-name', input.roleName, '--policy-name', input.policyName, '--policy-document', `file://${file}`],
      { redactCmd: true }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function registerAlarmInboxTaskDef(input: {
  region: string;
  prefix: string;
  templateTaskDefArn: string;
  queueUrl: string;
  env: 'staging' | 'production';
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

  patched.family = `${input.prefix}-alarm_inbox`;

  const containers: any[] = Array.isArray(patched.containerDefinitions) ? patched.containerDefinitions : [];
  if (containers.length !== 1) throw new Error('expected_single_container_taskdef');
  const c = { ...containers[0] };
  c.name = 'alarm_inbox';
  c.command = ['node', 'dist/workers/alarm-inbox-runner.js'];

  const env: Array<{ name: string; value: string }> = Array.isArray(c.environment) ? c.environment : [];
  const without = env.filter((e) => !['RETENTION_HEALTH_PORT', 'ALARM_INBOX_HEALTH_PORT', 'ALARM_INBOX_QUEUE_URL', 'ENVIRONMENT'].includes(String(e?.name ?? '')));
  c.environment = uniqEnv([
    ...without,
    { name: 'ENVIRONMENT', value: envLabel(input.env) },
    { name: 'ALARM_INBOX_HEALTH_PORT', value: '9106' },
    { name: 'ALARM_INBOX_QUEUE_URL', value: input.queueUrl },
  ]);

  if (c.logConfiguration?.options) {
    c.logConfiguration = {
      ...c.logConfiguration,
      options: {
        ...c.logConfiguration.options,
        'awslogs-group': `/ecs/${input.prefix}/alarm_inbox`,
        'awslogs-stream-prefix': 'alarm_inbox',
      },
    };
  }

  c.healthCheck = {
    command: ['CMD-SHELL', 'wget -q -O - http://127.0.0.1:$ALARM_INBOX_HEALTH_PORT/health >/dev/null 2>&1 || exit 1'],
    interval: 30,
    timeout: 5,
    retries: 3,
    startPeriod: 30,
  };

  patched.containerDefinitions = [c];

  const { dir, file } = await writeTempJsonFile(patched, 'proofwork-alarm-inbox-');
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

async function ensureEcsServiceRunning(input: {
  region: string;
  cluster: string;
  service: string;
  templateService: string;
  taskDefinitionArn: string;
}) {
  const existing = await getServiceJson({ region: input.region, cluster: input.cluster, service: input.service });
  const status = String(existing?.status ?? '').trim();
  const hasActive = status === 'ACTIVE' && String(existing?.serviceName ?? '').trim();
  if (hasActive) {
    await execFile(
      'aws',
      [
        'ecs',
        'update-service',
        '--region',
        input.region,
        '--cluster',
        input.cluster,
        '--service',
        input.service,
        '--task-definition',
        input.taskDefinitionArn,
        '--desired-count',
        '1',
      ],
      { redactCmd: true }
    );
    await execFile('aws', ['ecs', 'wait', 'services-stable', '--region', input.region, '--cluster', input.cluster, '--services', input.service], {
      redactCmd: true,
    });
    return;
  }

  const template = await getServiceJson({ region: input.region, cluster: input.cluster, service: input.templateService });
  const netCfg = template?.networkConfiguration;
  if (!netCfg) throw new Error('template_service_missing_network_configuration');

  const { dir, file } = await writeTempJsonFile(netCfg, 'proofwork-net-');
  try {
    await execFile(
      'aws',
      [
        'ecs',
        'create-service',
        '--region',
        input.region,
        '--cluster',
        input.cluster,
        '--service-name',
        input.service,
        '--task-definition',
        input.taskDefinitionArn,
        '--desired-count',
        '1',
        '--launch-type',
        'FARGATE',
        '--network-configuration',
        `file://${file}`,
      ],
      { redactCmd: true }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  await execFile('aws', ['ecs', 'wait', 'services-stable', '--region', input.region, '--cluster', input.cluster, '--services', input.service], {
    redactCmd: true,
  });
}

async function main() {
  const env = normalizeEnv(argValue('--env') ?? argValue('--environment') ?? 'staging');
  const region = String(argValue('--region') ?? process.env.AWS_REGION ?? 'us-east-1').trim();
  const prefix = prefixForEnv(env);

  const cluster = String(argValue('--cluster') ?? `${prefix}-cluster`).trim();
  const topicName = String(argValue('--topic-name') ?? `${prefix}-alarms`).trim();
  const retentionDaysRaw = Number(argValue('--log-retention-days') ?? 14);
  const retentionDays = Number.isFinite(retentionDaysRaw) ? Math.max(1, Math.min(365, Math.floor(retentionDaysRaw))) : 14;

  const enableAlarmInbox = hasFlag('--enable-alarm-inbox') || String(process.env.ENABLE_ALARM_INBOX ?? '').trim() === '1' || env === 'production';
  const service = String(argValue('--service') ?? `${prefix}-alarm_inbox`).trim();
  const templateService = String(argValue('--template-service') ?? `${prefix}-retention`).trim();
  const roleName = String(argValue('--ecs-task-role') ?? `${prefix}-ecs-task`).trim();
  const policyName = String(argValue('--ecs-task-policy') ?? `${prefix}-ecs-task-inline`).trim();

  console.log(`[alerting-enable] env=${env} region=${region} cluster=${cluster} topic=${topicName}`);

  const topicArn = await ensureSnsTopic({ region, name: topicName });
  await ensureCloudWatchAlarmsWired({ region, alarmNamePrefix: `${prefix}-`, topicArn });
  console.log(`[alerting-enable] alarms_wired topic_arn=${topicArn}`);

  if (!enableAlarmInbox) {
    console.log('[alerting-enable] enable_alarm_inbox=false (skipping alarm inbox service/queue)');
    return;
  }

  const queueName = `${prefix}-alarm-inbox`;
  const { queueUrl, queueArn } = await ensureSqsQueue({ region, queueName });
  await ensureSqsSubscription({ region, topicArn, queueArn, queueUrl });
  await ensureIamRoleCanDrainQueue({ region, roleName, policyName, queueArn });
  console.log(`[alerting-enable] alarm_inbox_queue=${queueName}`);

  await ensureCloudWatchLogGroup({ region, logGroupName: `/ecs/${prefix}/alarm_inbox`, retentionDays });

  const templateSvc = await getServiceJson({ region, cluster, service: templateService });
  const templateTdArn = String(templateSvc?.taskDefinition ?? '').trim();
  if (!templateTdArn) throw new Error('template_service_missing_task_definition');

  const newTdArn = await registerAlarmInboxTaskDef({ region, prefix, templateTaskDefArn: templateTdArn, queueUrl, env });
  await ensureEcsServiceRunning({ region, cluster, service, templateService, taskDefinitionArn: newTdArn });
  console.log(`[alerting-enable] alarm_inbox_service=ok (${service})`);

  if (hasFlag('--skip-canary')) {
    console.log('[alerting-enable] canary=skip');
    return;
  }

  // Fully automatable canary: Alarm -> SNS -> SQS.
  await execFile('bash', ['scripts/ops/test_alarm_notifications.sh', envLabel(env), topicArn, region], { redactCmd: true });
  console.log('[alerting-enable] canary=ok');
}

main().catch((err) => {
  console.error('[alerting-enable] failed', err);
  process.exitCode = 1;
});

