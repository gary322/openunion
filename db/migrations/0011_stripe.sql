-- Stripe integration tables (Postgres)

CREATE TABLE IF NOT EXISTS stripe_customers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS stripe_customers_org_uidx ON stripe_customers(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS stripe_customers_customer_uidx ON stripe_customers(stripe_customer_id);

-- Webhook event idempotency + auditing
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id TEXT PRIMARY KEY, -- stripe event id
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'received', -- received|processed|ignored|failed
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS stripe_webhook_events_status_idx ON stripe_webhook_events(status);
CREATE INDEX IF NOT EXISTS stripe_webhook_events_received_at_idx ON stripe_webhook_events(received_at);

