-- Supported origins allow system apps to work against curated third-party sites without per-buyer origin verification.
-- These origins are still enforced per job via allowedOrigins and strict worker enforcement.

CREATE TABLE IF NOT EXISTS app_supported_origins (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, origin)
);

CREATE INDEX IF NOT EXISTS idx_app_supported_origins_origin ON app_supported_origins(origin);

-- Marketplace-specific templates for deterministic selector-based extraction and (optional) search URL generation.
CREATE TABLE IF NOT EXISTS marketplace_origin_templates (
  origin TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT true,
  search_url_template TEXT NULL,
  wait_selector TEXT NULL,
  selectors_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketplace_origin_templates_enabled ON marketplace_origin_templates(enabled);

-- Buyer requests for adding an origin to an app's supported-origin allowlist (admin-approved).
CREATE TABLE IF NOT EXISTS app_origin_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  message TEXT NULL,
  reviewed_by TEXT NULL,
  review_notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_app_origin_requests_org_app_origin ON app_origin_requests(org_id, app_id, origin);
CREATE INDEX IF NOT EXISTS idx_app_origin_requests_status_created_at ON app_origin_requests(status, created_at);

