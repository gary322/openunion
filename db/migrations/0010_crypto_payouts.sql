-- Crypto payouts + transfer legs + worker payout identity (Postgres)

-- Worker payout identity (Base / EVM)
ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS payout_chain TEXT,
  ADD COLUMN IF NOT EXISTS payout_address TEXT,
  ADD COLUMN IF NOT EXISTS payout_address_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payout_address_proof JSONB;

CREATE INDEX IF NOT EXISTS workers_payout_chain_idx ON workers(payout_chain);
CREATE INDEX IF NOT EXISTS workers_payout_address_idx ON workers(payout_address);

-- Payout fee split metadata (gross is payouts.amount_cents)
ALTER TABLE payouts
  ADD COLUMN IF NOT EXISTS net_amount_cents INTEGER,
  ADD COLUMN IF NOT EXISTS platform_fee_cents INTEGER,
  ADD COLUMN IF NOT EXISTS platform_fee_bps INTEGER,
  ADD COLUMN IF NOT EXISTS platform_fee_wallet_address TEXT,
  ADD COLUMN IF NOT EXISTS payout_chain TEXT;

CREATE INDEX IF NOT EXISTS payouts_payout_chain_idx ON payouts(payout_chain);

-- Crypto payout transfer legs (net to worker + fee to platform wallet)
CREATE TABLE IF NOT EXISTS payout_transfers (
  id TEXT PRIMARY KEY,
  payout_id TEXT NOT NULL REFERENCES payouts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, -- net|fee
  chain_id INTEGER NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  token TEXT NOT NULL, -- usdc
  amount_base_units BIGINT NOT NULL,
  tx_hash TEXT,
  tx_nonce BIGINT,
  status TEXT NOT NULL DEFAULT 'created', -- created|broadcast|confirmed|failed
  broadcast_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS payout_transfers_payout_kind_uidx ON payout_transfers(payout_id, kind);
CREATE INDEX IF NOT EXISTS payout_transfers_status_idx ON payout_transfers(status);
CREATE INDEX IF NOT EXISTS payout_transfers_tx_hash_idx ON payout_transfers(tx_hash);

-- Per-chain signer nonce tracking (to avoid tx nonce races across workers)
CREATE TABLE IF NOT EXISTS crypto_nonces (
  chain_id INTEGER NOT NULL,
  from_address TEXT NOT NULL,
  next_nonce BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, from_address)
);

