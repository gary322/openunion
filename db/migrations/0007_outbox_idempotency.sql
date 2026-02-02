-- Outbox idempotency (Postgres)
-- A plain unique index allows multiple NULL idempotency keys, and supports ON CONFLICT inference.

DROP INDEX IF EXISTS outbox_events_topic_idem_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS outbox_events_topic_idem_uidx ON outbox_events(topic, idempotency_key);

