-- Artifact scanning/quarantine metadata (Postgres)

ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS bucket_kind TEXT, -- staging|clean|quarantine (S3); NULL for local
  ADD COLUMN IF NOT EXISTS scan_engine TEXT,
  ADD COLUMN IF NOT EXISTS scan_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scan_finished_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scan_reason TEXT,
  ADD COLUMN IF NOT EXISTS quarantine_key TEXT;

CREATE INDEX IF NOT EXISTS artifacts_bucket_kind_idx ON artifacts(bucket_kind);
CREATE INDEX IF NOT EXISTS artifacts_scan_finished_at_idx ON artifacts(scan_finished_at);

