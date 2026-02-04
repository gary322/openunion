-- Track worker liveness for pool operations / monitoring.

ALTER TABLE workers ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_workers_last_seen_at ON workers(last_seen_at);

