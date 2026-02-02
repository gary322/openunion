-- Retention + artifacts + outbox + audit + rate limit buckets (Postgres)

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  submission_id TEXT REFERENCES submissions(id) ON DELETE SET NULL,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  worker_id TEXT REFERENCES workers(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  label TEXT,
  sha256 TEXT,
  storage_key TEXT,
  final_url TEXT,
  content_type TEXT,
  size_bytes INTEGER,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  idempotency_key TEXT,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS retention_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applies_to TEXT NOT NULL,
  max_age_days INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS retention_jobs (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  run_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key TEXT PRIMARY KEY,
  tokens DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
