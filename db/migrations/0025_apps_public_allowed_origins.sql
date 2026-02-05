-- Apps: allow system-owned apps to declare operator-approved public origins (Postgres)
--
-- This enables built-in apps (owned by org_system) to work against third-party public origins
-- (e.g. arxiv.org, api.github.com) without requiring buyer orgs to "verify" those origins.
--
-- Workers still enforce strict origin allowlists per job constraints.

ALTER TABLE apps
  ADD COLUMN IF NOT EXISTS public_allowed_origins_json JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS apps_public_allowed_origins_gin ON apps USING gin (public_allowed_origins_json);

