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

async function registerOpsMetricsTaskDef(input: {
  region: string;
  prefix: string;
  templateTaskDefArn: string;
  env: 'staging' | 'production';
  pollMs: number;
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

  patched.family = `${input.prefix}-ops-metrics`;

  const containers: any[] = Array.isArray(patched.containerDefinitions) ? patched.containerDefinitions : [];
  if (containers.length !== 1) throw new Error('expected_single_container_taskdef');
  const c = { ...containers[0] };
  c.name = 'ops-metrics';
  c.command = ['node', 'dist/workers/ops-metrics-runner.js'];

  const env: Array<{ name: string; value: string }> = Array.isArray(c.environment) ? c.environment : [];
  const without = env.filter((e) => !['RETENTION_HEALTH_PORT', 'OPS_METRICS_HEALTH_PORT', 'OPS_METRICS_POLL_MS', 'ENVIRONMENT'].includes(String(e?.name ?? '')));
  c.environment = uniqEnv([
    ...without,
    { name: 'ENVIRONMENT', value: envLabel(input.env) },
    { name: 'OPS_METRICS_HEALTH_PORT', value: '9110' },
    { name: 'OPS_METRICS_POLL_MS', value: String(input.pollMs) },
  ]);

  if (c.logConfiguration?.options) {
    c.logConfiguration = {
      ...c.logConfiguration,
      options: {
        ...c.logConfiguration.options,
        'awslogs-group': `/ecs/${input.prefix}/ops-metrics`,
        'awslogs-stream-prefix': 'ops-metrics',
      },
    };
  }

  c.healthCheck = {
    command: ['CMD-SHELL', 'wget -q -O - http://127.0.0.1:$OPS_METRICS_HEALTH_PORT/health >/dev/null 2>&1 || exit 1'],
    interval: 30,
    timeout: 5,
    retries: 3,
    startPeriod: 30,
  };

  patched.containerDefinitions = [c];

  const { dir, file } = await writeTempJsonFile(patched, 'proofwork-ops-metrics-');
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

function alarmForSlo(input: {
  alarmName: string;
  topicArn: string;
  metricName: string;
  comparison: string;
  threshold: number;
  evalPeriods: number;
  datapointsToAlarm?: number;
  treatMissingData?: string;
  unit?: string;
  environment: string;
  dimensions?: Record<string, string>;
}) {
  const dims = [{ Name: 'Environment', Value: input.environment }, ...Object.entries(input.dimensions ?? {}).map(([k, v]) => ({ Name: k, Value: v }))];
  return {
    AlarmName: input.alarmName,
    AlarmDescription: `SLO alarm: ${input.metricName}`,
    Namespace: 'Proofwork',
    MetricName: input.metricName,
    Dimensions: dims,
    Statistic: 'Average',
    Period: 60,
    EvaluationPeriods: input.evalPeriods,
    ...(input.datapointsToAlarm ? { DatapointsToAlarm: input.datapointsToAlarm } : {}),
    Threshold: input.threshold,
    ComparisonOperator: input.comparison,
    TreatMissingData: input.treatMissingData ?? 'notBreaching',
    Unit: input.unit ?? undefined,
    OKActions: [input.topicArn],
    AlarmActions: [input.topicArn],
  };
}

async function upsertMetricAlarm(input: { region: string; alarm: any }) {
  const { dir, file } = await writeTempJsonFile(input.alarm, 'proofwork-slo-alarm-');
  try {
    await execFile('aws', ['cloudwatch', 'put-metric-alarm', '--region', input.region, '--cli-input-json', `file://${file}`], {
      redactCmd: true,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function ensureDashboard(input: { region: string; name: string; body: any }) {
  const { dir, file } = await writeTempJsonFile(input.body, 'proofwork-dashboard-');
  try {
    await execFile('aws', ['cloudwatch', 'put-dashboard', '--region', input.region, '--dashboard-name', input.name, '--dashboard-body', `file://${file}`], {
      redactCmd: true,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function widgetMetric(region: string, title: string, metrics: any[], yAxisLabel?: string) {
  return {
    type: 'metric',
    width: 12,
    height: 6,
    properties: {
      title,
      region,
      metrics,
      view: 'timeSeries',
      stacked: false,
      period: 60,
      yAxis: yAxisLabel ? { left: { label: yAxisLabel } } : undefined,
    },
  };
}

function cwMetricFromAlarm(alarm: any, opts?: { label?: string }) {
  const ns = String(alarm?.Namespace ?? '').trim();
  const name = String(alarm?.MetricName ?? '').trim();
  const dims: any[] = Array.isArray(alarm?.Dimensions) ? alarm.Dimensions : [];
  if (!ns || !name) return null;

  const arr: any[] = [ns, name];
  for (const d of dims) {
    const dn = String(d?.Name ?? '').trim();
    const dv = String(d?.Value ?? '').trim();
    if (!dn || !dv) continue;
    arr.push(dn, dv);
  }
  if (opts?.label) arr.push({ label: opts.label });
  return arr;
}

async function main() {
  const env = normalizeEnv(argValue('--env') ?? argValue('--environment') ?? 'staging');
  const region = String(argValue('--region') ?? process.env.AWS_REGION ?? 'us-east-1').trim();
  const prefix = prefixForEnv(env);
  const environment = envLabel(env);

  const cluster = String(argValue('--cluster') ?? `${prefix}-cluster`).trim();
  const service = String(argValue('--service') ?? `${prefix}-ops-metrics`).trim();
  const templateService = String(argValue('--template-service') ?? `${prefix}-retention`).trim();
  const retentionDaysRaw = Number(argValue('--log-retention-days') ?? 14);
  const retentionDays = Number.isFinite(retentionDaysRaw) ? Math.max(1, Math.min(365, Math.floor(retentionDaysRaw))) : 14;
  const pollMsRaw = Number(argValue('--poll-ms') ?? 60_000);
  const pollMs = Number.isFinite(pollMsRaw) ? Math.max(5_000, Math.min(10 * 60_000, Math.floor(pollMsRaw))) : 60_000;

  const topicName = String(argValue('--topic-name') ?? `${prefix}-alarms`).trim();
  const dashboardName = String(argValue('--dashboard-name') ?? `${prefix}-ops`).trim();

  console.log(`[monitoring-enable] env=${env} region=${region} cluster=${cluster} service=${service} dashboard=${dashboardName}`);

  const topicArn = await ensureSnsTopic({ region, name: topicName });

  await ensureCloudWatchLogGroup({ region, logGroupName: `/ecs/${prefix}/ops-metrics`, retentionDays });
  const templateSvc = await getServiceJson({ region, cluster, service: templateService });
  const templateTdArn = String(templateSvc?.taskDefinition ?? '').trim();
  if (!templateTdArn) throw new Error('template_service_missing_task_definition');

  const tdArn = await registerOpsMetricsTaskDef({ region, prefix, templateTaskDefArn: templateTdArn, env, pollMs });
  await ensureEcsServiceRunning({ region, cluster, service, templateService, taskDefinitionArn: tdArn });
  console.log('[monitoring-enable] ops_metrics_service=ok');

  // SLO alarms (based on docs/runbooks/SLOs.md).
  await upsertMetricAlarm({
    region,
    alarm: alarmForSlo({
      alarmName: `${prefix}-slo-workers-active`,
      topicArn,
      metricName: 'WorkersActive5m',
      comparison: 'LessThanThreshold',
      threshold: 1,
      evalPeriods: 10,
      datapointsToAlarm: 10,
      environment,
      unit: 'Count',
    }),
  });

  await upsertMetricAlarm({
    region,
    alarm: alarmForSlo({
      alarmName: `${prefix}-slo-verifier-backlog-age`,
      topicArn,
      metricName: 'VerifierBacklogAgeSeconds',
      comparison: 'GreaterThanThreshold',
      threshold: 300,
      evalPeriods: 10,
      datapointsToAlarm: 10,
      environment,
      unit: 'Seconds',
    }),
  });

  await upsertMetricAlarm({
    region,
    alarm: alarmForSlo({
      alarmName: `${prefix}-slo-artifact-scan-backlog-age`,
      topicArn,
      metricName: 'ArtifactScanBacklogAgeSeconds',
      comparison: 'GreaterThanThreshold',
      threshold: 300,
      evalPeriods: 10,
      datapointsToAlarm: 10,
      environment,
      unit: 'Seconds',
    }),
  });

  await upsertMetricAlarm({
    region,
    alarm: alarmForSlo({
      alarmName: `${prefix}-slo-outbox-deadletter`,
      topicArn,
      metricName: 'OutboxDeadletterTotal',
      comparison: 'GreaterThanThreshold',
      threshold: 0,
      evalPeriods: 1,
      datapointsToAlarm: 1,
      environment,
      unit: 'Count',
    }),
  });

  await upsertMetricAlarm({
    region,
    alarm: alarmForSlo({
      alarmName: `${prefix}-slo-outbox-pending-age-max`,
      topicArn,
      metricName: 'OutboxPendingMaxAgeSeconds',
      comparison: 'GreaterThanThreshold',
      threshold: 120,
      evalPeriods: 10,
      datapointsToAlarm: 10,
      environment,
      unit: 'Seconds',
    }),
  });

  await upsertMetricAlarm({
    region,
    alarm: alarmForSlo({
      alarmName: `${prefix}-slo-payouts-failed`,
      topicArn,
      metricName: 'PayoutsFailed',
      comparison: 'GreaterThanThreshold',
      threshold: 0,
      evalPeriods: 5,
      datapointsToAlarm: 5,
      environment,
      unit: 'Count',
    }),
  });

  const albLatencyAlarm = await awsJson(region, ['cloudwatch', 'describe-alarms', '--alarm-names', `${prefix}-alb-latency`, '--query', 'MetricAlarms[0]']);
  const alb5xxAlarm = await awsJson(region, ['cloudwatch', 'describe-alarms', '--alarm-names', `${prefix}-alb-target-5xx`, '--query', 'MetricAlarms[0]']);
  const apiCpuAlarm = await awsJson(region, ['cloudwatch', 'describe-alarms', '--alarm-names', `${prefix}-api-cpu-high`, '--query', 'MetricAlarms[0]']);
  const rdsCpuAlarm = await awsJson(region, ['cloudwatch', 'describe-alarms', '--alarm-names', `${prefix}-rds-cpu-high`, '--query', 'MetricAlarms[0]']);
  const rdsFreeAlarm = await awsJson(region, ['cloudwatch', 'describe-alarms', '--alarm-names', `${prefix}-rds-free-storage-low`, '--query', 'MetricAlarms[0]']);

  // Minimal ops dashboard (AWS infra + SLO gauges).
  const dashboard = {
    widgets: [
      widgetMetric(region, 'SLO: Workers active (5m)', [['Proofwork', 'WorkersActive5m', 'Environment', environment]]),
      widgetMetric(region, 'SLO: Verifier backlog age (s)', [['Proofwork', 'VerifierBacklogAgeSeconds', 'Environment', environment]], 'Seconds'),
      widgetMetric(region, 'SLO: Artifact scan backlog age (s)', [['Proofwork', 'ArtifactScanBacklogAgeSeconds', 'Environment', environment]], 'Seconds'),
      widgetMetric(region, 'SLO: Outbox max pending age (s)', [['Proofwork', 'OutboxPendingMaxAgeSeconds', 'Environment', environment]], 'Seconds'),
      widgetMetric(region, 'SLO: Outbox DLQ total', [['Proofwork', 'OutboxDeadletterTotal', 'Environment', environment]]),
      widgetMetric(region, 'SLO: Payouts failed', [['Proofwork', 'PayoutsFailed', 'Environment', environment]]),
      widgetMetric(region, 'Infra: ALB latency (avg)', [cwMetricFromAlarm(albLatencyAlarm, { label: 'TargetResponseTime' })].filter(Boolean)),
      widgetMetric(region, 'Infra: ALB target 5xx (sum)', [cwMetricFromAlarm(alb5xxAlarm, { label: 'HTTPCode_Target_5XX_Count' })].filter(Boolean)),
      widgetMetric(region, 'Infra: API CPU (avg)', [cwMetricFromAlarm(apiCpuAlarm, { label: 'CPUUtilization' })].filter(Boolean), '%'),
      widgetMetric(region, 'Infra: RDS CPU (avg)', [cwMetricFromAlarm(rdsCpuAlarm, { label: 'CPUUtilization' })].filter(Boolean), '%'),
      widgetMetric(region, 'Infra: RDS free storage (avg)', [cwMetricFromAlarm(rdsFreeAlarm, { label: 'FreeStorageSpace' })].filter(Boolean), 'Bytes'),
    ],
  };

  await ensureDashboard({ region, name: dashboardName, body: dashboard });
  console.log('[monitoring-enable] dashboard=ok');
  console.log('[monitoring-enable] ok');
}

main().catch((err) => {
  console.error('[monitoring-enable] failed', err);
  process.exitCode = 1;
});
