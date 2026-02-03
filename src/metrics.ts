import { pool } from './db/client.js';

const counters = new Map<string, number>();

export function inc(name: string, by = 1) {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

function promLine(name: string, value: number, labels?: Record<string, string>) {
  const labelStr =
    labels && Object.keys(labels).length
      ? '{' +
        Object.entries(labels)
          .map(([k, v]) => `${k}="${String(v).replaceAll('"', '\\"')}"`)
          .join(',') +
        '}'
      : '';
  return `${name}${labelStr} ${value}\n`;
}

export async function renderPrometheusMetrics(): Promise<string> {
  let out = '';

  // Counters (in-process)
  out += '# TYPE proofwork_requests_total counter\n';
  out += promLine('proofwork_requests_total', counters.get('requests_total') ?? 0);

  out += '# TYPE proofwork_claim_total counter\n';
  out += promLine('proofwork_claim_total', counters.get('claim_total') ?? 0);

  out += '# TYPE proofwork_submit_total counter\n';
  out += promLine('proofwork_submit_total', counters.get('submit_total') ?? 0);

  out += '# TYPE proofwork_duplicate_total counter\n';
  out += promLine('proofwork_duplicate_total', counters.get('duplicate_total') ?? 0);

  out += '# TYPE proofwork_verdict_total counter\n';
  out += promLine('proofwork_verdict_total', counters.get('verdict_total') ?? 0);

  out += '# TYPE proofwork_payout_requested_total counter\n';
  out += promLine('proofwork_payout_requested_total', counters.get('payout_requested_total') ?? 0);

  out += '# TYPE proofwork_payout_paid_total counter\n';
  out += promLine('proofwork_payout_paid_total', counters.get('payout_paid_total') ?? 0);

  out += '# TYPE proofwork_payout_failed_total counter\n';
  out += promLine('proofwork_payout_failed_total', counters.get('payout_failed_total') ?? 0);

  out += '# TYPE proofwork_artifact_scanned_total counter\n';
  out += promLine('proofwork_artifact_scanned_total', counters.get('artifact_scanned_total') ?? 0);

  out += '# TYPE proofwork_artifact_blocked_total counter\n';
  out += promLine('proofwork_artifact_blocked_total', counters.get('artifact_blocked_total') ?? 0);

  out += '# TYPE proofwork_platform_fee_cents_total counter\n';
  out += promLine('proofwork_platform_fee_cents_total', counters.get('platform_fee_cents_total') ?? 0);

  out += '# TYPE proofwork_fee_cents_total counter\n';
  out += promLine('proofwork_fee_cents_total', counters.get('proofwork_fee_cents_total') ?? 0);

  // Gauges (DB)
  const verBacklog = await pool.query<{ c: string }>(
    "SELECT count(*)::text as c FROM verifications WHERE status IN ('queued','in_progress')"
  );
  out += '# TYPE proofwork_verifier_backlog gauge\n';
  out += promLine('proofwork_verifier_backlog', Number(verBacklog.rows[0]?.c ?? 0));

  const outbox = await pool.query<{ topic: string; c: string }>(
    "SELECT topic, count(*)::text as c FROM outbox_events WHERE status='pending' GROUP BY topic"
  );
  out += '# TYPE proofwork_outbox_pending gauge\n';
  for (const r of outbox.rows) {
    out += promLine('proofwork_outbox_pending', Number(r.c), { topic: r.topic });
  }

  const outboxAges = await pool.query<{ topic: string; age: string | null }>(
    "SELECT topic, extract(epoch from (now() - min(created_at)))::text as age FROM outbox_events WHERE status='pending' GROUP BY topic"
  );
  out += '# TYPE proofwork_outbox_pending_age_seconds gauge\n';
  for (const r of outboxAges.rows) {
    if (r.age === null) continue;
    out += promLine('proofwork_outbox_pending_age_seconds', Number(r.age), { topic: r.topic });
  }

  const dlq = await pool.query<{ topic: string; c: string }>(
    "SELECT topic, count(*)::text as c FROM outbox_events WHERE status='deadletter' GROUP BY topic"
  );
  out += '# TYPE proofwork_outbox_deadletter gauge\n';
  for (const r of dlq.rows) {
    out += promLine('proofwork_outbox_deadletter', Number(r.c), { topic: r.topic });
  }

  const verAge = await pool.query<{ age: string | null }>(
    "SELECT extract(epoch from (now() - min(created_at)))::text as age FROM verifications WHERE status IN ('queued','in_progress')"
  );
  out += '# TYPE proofwork_verifier_backlog_age_seconds gauge\n';
  out += promLine('proofwork_verifier_backlog_age_seconds', Number(verAge.rows[0]?.age ?? 0));

  const payoutsByStatus = await pool.query<{ status: string; c: string }>(
    'SELECT status, count(*)::text as c FROM payouts GROUP BY status'
  );
  out += '# TYPE proofwork_payouts gauge\n';
  for (const r of payoutsByStatus.rows) {
    out += promLine('proofwork_payouts', Number(r.c), { status: r.status });
  }

  const artifactsByStatus = await pool.query<{ status: string; c: string }>(
    'SELECT status, count(*)::text as c FROM artifacts GROUP BY status'
  );
  out += '# TYPE proofwork_artifacts gauge\n';
  for (const r of artifactsByStatus.rows) {
    out += promLine('proofwork_artifacts', Number(r.c), { status: r.status });
  }

  const rateLimited = await pool.query<{ c: string }>(
    "SELECT count(*)::text as c FROM workers WHERE rate_limited_until IS NOT NULL AND rate_limited_until > now()"
  );
  out += '# TYPE proofwork_workers_rate_limited gauge\n';
  out += promLine('proofwork_workers_rate_limited', Number(rateLimited.rows[0]?.c ?? 0));

  // Jobs stale vs freshness SLA (task_descriptor)
  const staleJobs = await pool.query<{ c: string }>(
    `SELECT count(*)::text as c
     FROM jobs
     WHERE status = 'open'
       AND task_descriptor ? 'freshness_sla_sec'
       AND created_at < now() - ((task_descriptor->>'freshness_sla_sec')::int || ' seconds')::interval`
  );
  out += '# TYPE proofwork_jobs_stale gauge\n';
  out += promLine('proofwork_jobs_stale', Number(staleJobs.rows[0]?.c ?? 0));

  const scanAge = await pool.query<{ age: string | null }>(
    "SELECT extract(epoch from (now() - min(created_at)))::text as age FROM artifacts WHERE status IN ('uploaded','scan_failed')"
  );
  out += '# TYPE proofwork_artifact_scan_backlog_age_seconds gauge\n';
  out += promLine('proofwork_artifact_scan_backlog_age_seconds', Number(scanAge.rows[0]?.age ?? 0));

  return out;
}
