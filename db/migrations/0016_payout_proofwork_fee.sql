-- Proofwork fee split metadata (Postgres)
--
-- We always take a fixed Proofwork fee (default 1%) in addition to any per-org platform fee.
-- Both fees are taken from payouts.amount_cents (gross), and net_amount_cents is what the worker receives.

ALTER TABLE payouts
  ADD COLUMN IF NOT EXISTS proofwork_fee_cents INTEGER,
  ADD COLUMN IF NOT EXISTS proofwork_fee_bps INTEGER,
  ADD COLUMN IF NOT EXISTS proofwork_fee_wallet_address TEXT;

CREATE INDEX IF NOT EXISTS payouts_proofwork_fee_cents_idx ON payouts(proofwork_fee_cents);

