-- Add app-defined UI schema for friendly forms (Postgres)
-- Used by /apps/app/:slug/ and built-in vertical pages to render non-JSON "Create work" flows.

ALTER TABLE apps
  ADD COLUMN IF NOT EXISTS ui_schema JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS apps_ui_schema_gin ON apps USING gin (ui_schema);

