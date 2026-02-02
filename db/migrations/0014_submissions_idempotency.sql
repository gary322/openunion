-- Submissions idempotency (Postgres)
-- Allows workers to safely retry /api/jobs/:jobId/submit without creating duplicate submissions.

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS request_hash TEXT;

-- A plain unique index allows multiple NULL idempotency keys.
CREATE UNIQUE INDEX IF NOT EXISTS submissions_job_worker_idem_uidx
  ON submissions(job_id, worker_id, idempotency_key);

