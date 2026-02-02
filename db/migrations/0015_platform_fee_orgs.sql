-- Per-org platform fee settings (Postgres)

-- Each buyer org ("platform") can take its own cut from worker payouts.
-- Proofwork's own platform fee is configured separately via env and recorded on payouts.

ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS platform_fee_bps INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS platform_fee_wallet_address TEXT;

-- Basic sanity constraint (0%..100%).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orgs_platform_fee_bps_chk'
  ) THEN
    ALTER TABLE orgs
      ADD CONSTRAINT orgs_platform_fee_bps_chk
      CHECK (platform_fee_bps >= 0 AND platform_fee_bps <= 10000);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS orgs_platform_fee_bps_idx ON orgs(platform_fee_bps);
