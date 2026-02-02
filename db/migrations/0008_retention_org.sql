-- Org-scoped retention policies (Postgres)

ALTER TABLE retention_policies
  ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES orgs(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS retention_policies_org_id_idx ON retention_policies(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS retention_policies_org_applies_uidx ON retention_policies(org_id, applies_to);

