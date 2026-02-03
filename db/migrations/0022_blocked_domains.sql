-- Global domain/origin blocklist (admin-controlled).
--
-- This is a safety valve for abuse/ToS issues: block certain origins from being verified or used.

CREATE TABLE IF NOT EXISTS blocked_domains (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Uniqueness is case-insensitive.
CREATE UNIQUE INDEX IF NOT EXISTS blocked_domains_domain_lower_uidx ON blocked_domains ((lower(domain)));

