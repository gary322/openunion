-- Billing ledger + reservations (minimal, Postgres)

CREATE TABLE IF NOT EXISTS billing_accounts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bounty_budget_reservations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
  bounty_id TEXT NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS payment_intents (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_ref TEXT,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
