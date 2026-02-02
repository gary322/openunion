-- Core schema (Postgres)

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  status TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  capabilities_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  rate_limited_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bounties (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  allowed_origins JSONB NOT NULL DEFAULT '[]'::jsonb,
  journey_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  payout_cents INTEGER NOT NULL,
  coverage_payout_cents INTEGER NOT NULL DEFAULT 0,
  required_proofs INTEGER NOT NULL,
  fingerprint_classes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  dispute_window_sec INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  bounty_id TEXT NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  fingerprint_class TEXT NOT NULL,
  status TEXT NOT NULL,
  lease_worker_id TEXT REFERENCES workers(id) ON DELETE SET NULL,
  lease_expires_at TIMESTAMPTZ,
  lease_nonce TEXT,
  current_submission_id TEXT,
  final_verdict TEXT,
  final_quality_score REAL,
  done_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  manifest_json JSONB NOT NULL,
  artifact_index_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL,
  dedupe_key TEXT,
  final_verdict TEXT,
  final_quality_score REAL,
  payout_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL,
  claim_token TEXT,
  claimed_by TEXT,
  claim_expires_at TIMESTAMPTZ,
  verdict TEXT,
  reason TEXT,
  scorecard_json JSONB,
  evidence_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  provider TEXT,
  provider_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reputation (
  worker_id TEXT PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
  alpha INTEGER NOT NULL,
  beta INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accepted_dedupe (
  bounty_id TEXT NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bounty_id, dedupe_key)
);
