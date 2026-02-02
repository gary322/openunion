-- Bounty priority (Postgres)

ALTER TABLE bounties
  ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS bounties_status_priority_idx ON bounties(status, priority DESC, payout_cents DESC);

