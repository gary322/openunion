-- Apps registry + per-org CORS allowlist + dispute/payout metadata (Postgres)

-- System org for built-in apps (safe no-op if already created)
INSERT INTO orgs(id, name, created_at)
VALUES ('org_system', 'Proofwork System', now())
ON CONFLICT (id) DO NOTHING;

-- Orgs: per-org browser CORS allowlist + basic quota fields (nullable = unlimited)
ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS cors_allow_origins JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS daily_spend_limit_cents INTEGER,
  ADD COLUMN IF NOT EXISTS monthly_spend_limit_cents INTEGER,
  ADD COLUMN IF NOT EXISTS max_published_bounties INTEGER,
  ADD COLUMN IF NOT EXISTS max_open_jobs INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orgs_daily_spend_limit_cents_chk') THEN
    ALTER TABLE orgs ADD CONSTRAINT orgs_daily_spend_limit_cents_chk CHECK (daily_spend_limit_cents IS NULL OR daily_spend_limit_cents >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orgs_monthly_spend_limit_cents_chk') THEN
    ALTER TABLE orgs ADD CONSTRAINT orgs_monthly_spend_limit_cents_chk CHECK (monthly_spend_limit_cents IS NULL OR monthly_spend_limit_cents >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orgs_max_published_bounties_chk') THEN
    ALTER TABLE orgs ADD CONSTRAINT orgs_max_published_bounties_chk CHECK (max_published_bounties IS NULL OR max_published_bounties >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orgs_max_open_jobs_chk') THEN
    ALTER TABLE orgs ADD CONSTRAINT orgs_max_open_jobs_chk CHECK (max_open_jobs IS NULL OR max_open_jobs >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS orgs_cors_allow_origins_gin ON orgs USING gin (cors_allow_origins);

-- Payouts: hold metadata + block reasons (UI/ops visibility)
ALTER TABLE payouts
  ADD COLUMN IF NOT EXISTS hold_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS blocked_reason TEXT;

CREATE INDEX IF NOT EXISTS payouts_hold_until_idx ON payouts(hold_until);

-- Disputes: resolution metadata
ALTER TABLE disputes
  ADD COLUMN IF NOT EXISTS resolution TEXT,
  ADD COLUMN IF NOT EXISTS resolution_notes TEXT;

CREATE INDEX IF NOT EXISTS disputes_submission_id_idx ON disputes(submission_id);
CREATE INDEX IF NOT EXISTS disputes_payout_id_idx ON disputes(payout_id);

-- Apps registry
CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  owner_org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  task_type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  dashboard_url TEXT,
  public BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'active', -- active|disabled
  default_descriptor JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS apps_slug_uidx ON apps(slug);
CREATE UNIQUE INDEX IF NOT EXISTS apps_task_type_uidx ON apps(task_type);
CREATE INDEX IF NOT EXISTS apps_owner_org_id_idx ON apps(owner_org_id);
CREATE INDEX IF NOT EXISTS apps_public_status_idx ON apps(public, status);

-- Backfill built-in apps (idempotent)
INSERT INTO apps(id, owner_org_id, slug, task_type, name, description, dashboard_url, public, status, default_descriptor, created_at, updated_at)
VALUES
  ('app_clips', 'org_system', 'clips', 'clips_highlights', 'Clips', 'VOD clipping, highlights, timestamping.', NULL, true, 'active', '{}'::jsonb, now(), now()),
  ('app_marketplace', 'org_system', 'marketplace', 'marketplace_pricecheck', 'Marketplace', 'Price checks, drops, screenshots.', NULL, true, 'active', '{}'::jsonb, now(), now()),
  ('app_jobs', 'org_system', 'jobs', 'jobs_resume', 'Jobs', 'Job scraping, resume support.', NULL, true, 'active', '{}'::jsonb, now(), now()),
  ('app_travel', 'org_system', 'travel', 'travel_deals', 'Travel', 'Flights/hotels deal hunting.', NULL, true, 'active', '{}'::jsonb, now(), now()),
  ('app_research', 'org_system', 'research', 'research_arxiv', 'Research', 'ArXiv idea-to-plan reports.', NULL, true, 'active', '{}'::jsonb, now(), now()),
  ('app_github', 'org_system', 'github', 'github_scan', 'GitHub Scan', 'Repo discovery, licensing, similarity.', NULL, true, 'active', '{}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;

