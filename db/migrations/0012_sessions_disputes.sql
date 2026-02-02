-- Sessions (buyer/admin) + disputes (Postgres)

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  csrf_secret TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_org_id_idx ON sessions(org_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  bounty_id TEXT NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  submission_id TEXT REFERENCES submissions(id) ON DELETE SET NULL,
  payout_id TEXT REFERENCES payouts(id) ON DELETE SET NULL,
  status TEXT NOT NULL, -- open|resolved|cancelled
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolver_actor_type TEXT,
  resolver_actor_id TEXT
);

CREATE INDEX IF NOT EXISTS disputes_org_id_idx ON disputes(org_id);
CREATE INDEX IF NOT EXISTS disputes_bounty_id_idx ON disputes(bounty_id);
CREATE INDEX IF NOT EXISTS disputes_status_idx ON disputes(status);

