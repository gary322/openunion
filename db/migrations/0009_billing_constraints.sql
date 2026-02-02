-- Billing constraints + indexes (Postgres)

-- One billing account per org.
CREATE UNIQUE INDEX IF NOT EXISTS billing_accounts_org_uidx ON billing_accounts(org_id);

-- One active reservation record per bounty (status transitions handled in app logic).
CREATE UNIQUE INDEX IF NOT EXISTS bounty_budget_reservations_bounty_uidx ON bounty_budget_reservations(bounty_id);

