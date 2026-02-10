// Load .env only in non-test environments
const _loadEnv =
  process.env.NODE_ENV !== 'test' && !process.env.VITEST ? import('dotenv/config').catch(() => {}) : Promise.resolve();
await _loadEnv;

import { runMigrations } from '../src/db/migrate.js';
import { pool } from '../src/db/client.js';
import { startWorkerHealthServer } from './health.js';

type GaugeSnapshot = {
  verifierBacklog: number;
  verifierBacklogAgeSeconds: number;
  artifactScanBacklogAgeSeconds: number;
  jobsStale: number;
  workersActive5m: number;
  workersRateLimited: number;
  outboxPendingTotal: number;
  outboxPendingMaxAgeSeconds: number;
  outboxDeadletterTotal: number;
  payoutsPending: number;
  payoutsBlocked: number;
  payoutsFailed: number;
  payoutPendingAgeSeconds: number;
};

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.floor(raw);
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

function envLabel(): string {
  const raw = String(process.env.ENVIRONMENT ?? process.env.APP_ENV ?? '').trim().toLowerCase();
  if (raw === 'production') return 'prod';
  if (raw) return raw;
  return 'unknown';
}

function emfRecord(input: {
  namespace: string;
  dimensions: Record<string, string>;
  metrics: Array<{ name: string; unit?: string }>;
  values: Record<string, number>;
}) {
  const dims = Object.keys(input.dimensions);
  const CloudWatchMetrics = [
    {
      Namespace: input.namespace,
      Dimensions: [dims],
      Metrics: input.metrics.map((m) => ({ Name: m.name, Unit: m.unit ?? 'None' })),
    },
  ];

  return {
    _aws: { Timestamp: Date.now(), CloudWatchMetrics },
    ...input.dimensions,
    ...input.values,
  };
}

async function collectSnapshot(): Promise<{ gauges: GaugeSnapshot; outboxByTopic: Array<{ topic: string; pending: number; pendingAgeSeconds: number; deadletter: number }> }> {
  const verBacklog = await pool.query<{ c: string }>(
    "SELECT count(*)::text as c FROM verifications WHERE status IN ('queued','in_progress')"
  );
  const verAge = await pool.query<{ age: string | null }>(
    "SELECT extract(epoch from (now() - min(created_at)))::text as age FROM verifications WHERE status IN ('queued','in_progress')"
  );
  const scanAge = await pool.query<{ age: string | null }>(
    "SELECT extract(epoch from (now() - min(created_at)))::text as age FROM artifacts WHERE status IN ('uploaded','scan_failed')"
  );
  const staleJobs = await pool.query<{ c: string }>(
    `SELECT count(*)::text as c
     FROM jobs
     WHERE status = 'open'
       AND task_descriptor ? 'freshness_sla_sec'
       AND created_at < now() - ((task_descriptor->>'freshness_sla_sec')::int || ' seconds')::interval`
  );
  const rateLimited = await pool.query<{ c: string }>(
    "SELECT count(*)::text as c FROM workers WHERE rate_limited_until IS NOT NULL AND rate_limited_until > now()"
  );
  const workersActive5m = await pool.query<{ c: string }>(
    "SELECT count(*)::text as c FROM workers WHERE last_seen_at IS NOT NULL AND last_seen_at > now() - interval '5 minutes'"
  );

  const outboxPendingByTopic = await pool.query<{ topic: string; c: string }>(
    "SELECT topic, count(*)::text as c FROM outbox_events WHERE status='pending' GROUP BY topic"
  );
  const outboxAgesByTopic = await pool.query<{ topic: string; age: string | null }>(
    "SELECT topic, extract(epoch from (now() - min(created_at)))::text as age FROM outbox_events WHERE status='pending' GROUP BY topic"
  );
  const outboxDeadByTopic = await pool.query<{ topic: string; c: string }>(
    "SELECT topic, count(*)::text as c FROM outbox_events WHERE status='deadletter' GROUP BY topic"
  );

  const pendingMap = new Map(outboxPendingByTopic.rows.map((r) => [r.topic, Number(r.c ?? 0)]));
  const ageMap = new Map(outboxAgesByTopic.rows.map((r) => [r.topic, Number(r.age ?? 0)]));
  const deadMap = new Map(outboxDeadByTopic.rows.map((r) => [r.topic, Number(r.c ?? 0)]));

  const topics = new Set<string>([...pendingMap.keys(), ...ageMap.keys(), ...deadMap.keys()]);
  const outboxByTopic = Array.from(topics)
    .sort()
    .map((topic) => ({
      topic,
      pending: pendingMap.get(topic) ?? 0,
      pendingAgeSeconds: ageMap.get(topic) ?? 0,
      deadletter: deadMap.get(topic) ?? 0,
    }));

  const outboxPendingTotal = outboxByTopic.reduce((sum, r) => sum + r.pending, 0);
  const outboxDeadletterTotal = outboxByTopic.reduce((sum, r) => sum + r.deadletter, 0);
  const outboxPendingMaxAgeSeconds = outboxByTopic.reduce((m, r) => Math.max(m, r.pendingAgeSeconds), 0);

  const payoutsByStatus = await pool.query<{ status: string; c: string }>('SELECT status, count(*)::text as c FROM payouts GROUP BY status');
  const payoutMap = new Map(payoutsByStatus.rows.map((r) => [r.status, Number(r.c ?? 0)]));
  const payoutPendingAge = await pool.query<{ age: string | null }>(
    "SELECT extract(epoch from (now() - min(created_at)))::text as age FROM payouts WHERE status='pending'"
  );

  const gauges: GaugeSnapshot = {
    verifierBacklog: Number(verBacklog.rows[0]?.c ?? 0),
    verifierBacklogAgeSeconds: Number(verAge.rows[0]?.age ?? 0),
    artifactScanBacklogAgeSeconds: Number(scanAge.rows[0]?.age ?? 0),
    jobsStale: Number(staleJobs.rows[0]?.c ?? 0),
    workersActive5m: Number(workersActive5m.rows[0]?.c ?? 0),
    workersRateLimited: Number(rateLimited.rows[0]?.c ?? 0),
    outboxPendingTotal,
    outboxPendingMaxAgeSeconds,
    outboxDeadletterTotal,
    payoutsPending: payoutMap.get('pending') ?? 0,
    payoutsBlocked: payoutMap.get('blocked') ?? 0,
    payoutsFailed: payoutMap.get('failed') ?? 0,
    payoutPendingAgeSeconds: Number(payoutPendingAge.rows[0]?.age ?? 0),
  };

  return { gauges, outboxByTopic };
}

async function main() {
  await runMigrations();

  const pollMs = clampInt(envInt('OPS_METRICS_POLL_MS', 60_000), 5_000, 10 * 60_000);
  const environment = envLabel();

  let lastRunAt: string | null = null;
  let lastError: string | null = null;
  let lastGauges: GaugeSnapshot | null = null;

  await startWorkerHealthServer({
    name: 'ops-metrics-runner',
    portEnv: 'OPS_METRICS_HEALTH_PORT',
    defaultPort: 9110,
    getStatus: async () => ({ environment, pollMs, lastRunAt, lastError, lastGauges }),
  });

  // eslint-disable-next-line no-console
  console.log(`[ops_metrics] start env=${environment} pollMs=${pollMs}`);

  while (true) {
    try {
      const snap = await collectSnapshot();
      lastRunAt = new Date().toISOString();
      lastError = null;
      lastGauges = snap.gauges;

      const baseDims = { Environment: environment };

      // Global gauges.
      console.log(
        JSON.stringify(
          emfRecord({
            namespace: 'Proofwork',
            dimensions: baseDims,
            metrics: [
              { name: 'VerifierBacklog', unit: 'Count' },
              { name: 'VerifierBacklogAgeSeconds', unit: 'Seconds' },
              { name: 'ArtifactScanBacklogAgeSeconds', unit: 'Seconds' },
              { name: 'JobsStale', unit: 'Count' },
              { name: 'WorkersActive5m', unit: 'Count' },
              { name: 'WorkersRateLimited', unit: 'Count' },
              { name: 'OutboxPendingTotal', unit: 'Count' },
              { name: 'OutboxPendingMaxAgeSeconds', unit: 'Seconds' },
              { name: 'OutboxDeadletterTotal', unit: 'Count' },
              { name: 'PayoutsPending', unit: 'Count' },
              { name: 'PayoutsBlocked', unit: 'Count' },
              { name: 'PayoutsFailed', unit: 'Count' },
              { name: 'PayoutPendingAgeSeconds', unit: 'Seconds' },
            ],
            values: {
              VerifierBacklog: snap.gauges.verifierBacklog,
              VerifierBacklogAgeSeconds: snap.gauges.verifierBacklogAgeSeconds,
              ArtifactScanBacklogAgeSeconds: snap.gauges.artifactScanBacklogAgeSeconds,
              JobsStale: snap.gauges.jobsStale,
              WorkersActive5m: snap.gauges.workersActive5m,
              WorkersRateLimited: snap.gauges.workersRateLimited,
              OutboxPendingTotal: snap.gauges.outboxPendingTotal,
              OutboxPendingMaxAgeSeconds: snap.gauges.outboxPendingMaxAgeSeconds,
              OutboxDeadletterTotal: snap.gauges.outboxDeadletterTotal,
              PayoutsPending: snap.gauges.payoutsPending,
              PayoutsBlocked: snap.gauges.payoutsBlocked,
              PayoutsFailed: snap.gauges.payoutsFailed,
              PayoutPendingAgeSeconds: snap.gauges.payoutPendingAgeSeconds,
            },
          })
        )
      );

      // Outbox per-topic gauges (low-cardinality, but useful for targeted alarms).
      for (const r of snap.outboxByTopic) {
        console.log(
          JSON.stringify(
            emfRecord({
              namespace: 'Proofwork',
              dimensions: { ...baseDims, Topic: r.topic },
              metrics: [
                { name: 'OutboxPending', unit: 'Count' },
                { name: 'OutboxPendingAgeSeconds', unit: 'Seconds' },
                { name: 'OutboxDeadletter', unit: 'Count' },
              ],
              values: { OutboxPending: r.pending, OutboxPendingAgeSeconds: r.pendingAgeSeconds, OutboxDeadletter: r.deadletter },
            })
          )
        );
      }
    } catch (err: any) {
      lastError = String(err?.message ?? err);
      // eslint-disable-next-line no-console
      console.error(`[ops_metrics] failed err=${lastError}`);
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

