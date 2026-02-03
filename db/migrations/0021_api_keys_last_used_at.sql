-- Track last usage timestamps for org API keys (helps key rotation and incident response UX).

ALTER TABLE org_api_keys
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS org_api_keys_last_used_at_idx ON org_api_keys(last_used_at);

