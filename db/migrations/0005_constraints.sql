-- Constraints + indexes (Postgres)

-- Jobs
CREATE INDEX IF NOT EXISTS jobs_bounty_id_idx ON jobs(bounty_id);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_lease_expires_at_idx ON jobs(lease_expires_at);

-- Submissions
CREATE INDEX IF NOT EXISTS submissions_job_id_idx ON submissions(job_id);
CREATE INDEX IF NOT EXISTS submissions_worker_id_idx ON submissions(worker_id);
CREATE INDEX IF NOT EXISTS submissions_dedupe_key_idx ON submissions(dedupe_key);
CREATE INDEX IF NOT EXISTS submissions_final_verdict_idx ON submissions(final_verdict);

-- Verifications
CREATE UNIQUE INDEX IF NOT EXISTS verifications_submission_attempt_uidx ON verifications(submission_id, attempt_no);
CREATE INDEX IF NOT EXISTS verifications_status_idx ON verifications(status);

-- Payouts
CREATE UNIQUE INDEX IF NOT EXISTS payouts_submission_uidx ON payouts(submission_id);
CREATE INDEX IF NOT EXISTS payouts_status_idx ON payouts(status);

-- Buyer tables
CREATE UNIQUE INDEX IF NOT EXISTS org_users_email_uidx ON org_users((lower(email)));
CREATE UNIQUE INDEX IF NOT EXISTS org_api_keys_prefix_uidx ON org_api_keys(key_prefix);
CREATE UNIQUE INDEX IF NOT EXISTS origins_org_origin_uidx ON origins(org_id, origin);

-- Outbox
CREATE INDEX IF NOT EXISTS outbox_events_status_available_idx ON outbox_events(status, available_at);
CREATE UNIQUE INDEX IF NOT EXISTS outbox_events_topic_idem_uidx ON outbox_events(topic, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Artifacts / retention
CREATE INDEX IF NOT EXISTS artifacts_expires_at_idx ON artifacts(expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS retention_jobs_run_at_idx ON retention_jobs(run_at) WHERE status = 'pending';

-- Add FK for current_submission_id (created after submissions table exists)
ALTER TABLE jobs
  ADD CONSTRAINT jobs_current_submission_fk
  FOREIGN KEY (current_submission_id) REFERENCES submissions(id) ON DELETE SET NULL;
