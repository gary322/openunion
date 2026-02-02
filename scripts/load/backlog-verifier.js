import pg from 'pg';
import { nanoid } from 'nanoid';

const { Pool } = pg;

const dbUrl = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/proofwork';
const verifications = Number(process.env.BACKLOG_VERIFICATIONS ?? 100);
const outboxEvents = Number(process.env.BACKLOG_OUTBOX ?? verifications);
const artifacts = Number(process.env.BACKLOG_ARTIFACTS ?? 0);
const ageSec = Number(process.env.BACKLOG_AGE_SEC ?? 0);

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DANGEROUS_LOAD !== 'true') {
  console.error('Refusing to run in production without ALLOW_DANGEROUS_LOAD=true');
  process.exit(1);
}
if (!Number.isFinite(verifications) || verifications < 0) throw new Error('invalid BACKLOG_VERIFICATIONS');
if (!Number.isFinite(outboxEvents) || outboxEvents < 0) throw new Error('invalid BACKLOG_OUTBOX');
if (!Number.isFinite(artifacts) || artifacts < 0) throw new Error('invalid BACKLOG_ARTIFACTS');
if (!Number.isFinite(ageSec) || ageSec < 0) throw new Error('invalid BACKLOG_AGE_SEC');

const createdAt = new Date(Date.now() - ageSec * 1000);

async function ensureOrgBountyJob(client) {
  const job = await client.query('SELECT id, bounty_id FROM jobs ORDER BY created_at DESC LIMIT 1');
  if (job.rows[0]) return { jobId: job.rows[0].id, bountyId: job.rows[0].bounty_id };

  const orgId = 'org_load';
  await client.query(
    `INSERT INTO orgs(id, name, created_at) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [orgId, 'Load Org', createdAt]
  );

  const bountyId = `b_${nanoid(10)}`;
  await client.query(
    `INSERT INTO bounties(
       id, org_id, title, description, status,
       allowed_origins, journey_json,
       payout_cents, coverage_payout_cents, required_proofs,
       fingerprint_classes_json, tags, dispute_window_sec, priority,
       created_at, published_at
     ) VALUES (
       $1, $2, $3, $4, 'published',
       '[]'::jsonb, '{}'::jsonb,
       1000, 0, 1,
       '["desktop_us"]'::jsonb, '[]'::jsonb, 0, 0,
       $5, $5
     )`,
    [bountyId, orgId, 'Load bounty', 'Backlog generator', createdAt]
  );

  const jobId = `j_${nanoid(10)}`;
  await client.query(
    `INSERT INTO jobs(id, bounty_id, fingerprint_class, status, created_at)
     VALUES ($1, $2, $3, 'open', $4)`,
    [jobId, bountyId, 'desktop_us', createdAt]
  );

  return { jobId, bountyId };
}

async function ensureWorker(client) {
  const w = await client.query('SELECT id FROM workers ORDER BY created_at DESC LIMIT 1');
  if (w.rows[0]) return w.rows[0].id;

  const id = `wk_${nanoid(10)}`;
  await client.query(
    `INSERT INTO workers(id, display_name, status, key_prefix, key_hash, capabilities_json, rate_limited_until, created_at)
     VALUES ($1, $2, 'active', $3, $4, '{}'::jsonb, NULL, $5)`,
    [id, 'load', `pw_wk_${nanoid(10)}`, nanoid(32), createdAt]
  );
  return id;
}

(async () => {
  const pool = new Pool({ connectionString: dbUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { jobId } = await ensureOrgBountyJob(client);
    const workerId = await ensureWorker(client);

    const submissionIds = [];

    for (let i = 0; i < verifications; i++) {
      const subId = `sub_${nanoid(12)}`;
      submissionIds.push(subId);
      await client.query(
        `INSERT INTO submissions(
           id, job_id, worker_id, idempotency_key, request_hash,
           manifest_json, artifact_index_json, status, dedupe_key, final_verdict, final_quality_score, payout_status, created_at
         ) VALUES (
           $1, $2, $3, $4, NULL,
           '{}'::jsonb, '[]'::jsonb, 'submitted', NULL, NULL, NULL, NULL, $5
         )`,
        [subId, jobId, workerId, `idem_${i}`, createdAt]
      );

      const verId = `ver_${nanoid(12)}`;
      await client.query(
        `INSERT INTO verifications(
           id, submission_id, attempt_no, status, claim_token, claimed_by, claim_expires_at,
           verdict, reason, scorecard_json, evidence_json, created_at
         ) VALUES (
           $1, $2, 1, 'queued', NULL, NULL, NULL,
           NULL, NULL, NULL, NULL, $3
         )`,
        [verId, subId, createdAt]
      );
    }

    for (let i = 0; i < outboxEvents; i++) {
      const id = `evt_${nanoid(12)}`;
      const subId = submissionIds[i % Math.max(1, submissionIds.length)] ?? `sub_fake_${i}`;
      const payload = { submissionId: subId, attemptNo: 1, verificationId: `ver_backlog_${i}` };
      await client.query(
        `INSERT INTO outbox_events(
           id, topic, idempotency_key, payload, status, attempts, available_at, locked_at, locked_by, last_error, created_at, sent_at
         ) VALUES (
           $1, 'verification.requested', $2, $3::jsonb, 'pending', 0, $4, NULL, NULL, NULL, $4, NULL
         )
         ON CONFLICT (topic, idempotency_key) DO NOTHING`,
        [id, `verification_backlog:${i}`, JSON.stringify(payload), createdAt]
      );
    }

    for (let i = 0; i < artifacts; i++) {
      const artId = `art_${nanoid(12)}`;
      await client.query(
        `INSERT INTO artifacts(
           id, submission_id, job_id, worker_id, kind, label, sha256, storage_key, final_url, content_type, size_bytes, status, created_at, expires_at, deleted_at
         ) VALUES (
           $1, NULL, $2, $3, 'other', $4, NULL, NULL, NULL, 'text/plain', 0, 'uploaded', $5, NULL, NULL
         )`,
        [artId, jobId, workerId, `backlog_${i}`, createdAt]
      );
    }

    await client.query('COMMIT');

    console.log(
      JSON.stringify(
        {
          dbUrl,
          createdAt: createdAt.toISOString(),
          verifications,
          outboxEvents,
          artifacts,
          note: 'This is intended to create backpressure conditions for /api/jobs/next in non-production environments.',
        },
        null,
        2
      )
    );
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

