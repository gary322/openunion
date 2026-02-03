-- Fix alarm_notifications unique index so INSERT ... ON CONFLICT works on Postgres.
--
-- Postgres can't match ON CONFLICT(topic_arn, sns_message_id) against a *partial* unique index
-- unless the conflict target includes the same WHERE clause. Our insert path uses
-- `ON CONFLICT (topic_arn, sns_message_id) DO NOTHING`, so we need a full unique index.
--
-- Note: Postgres unique indexes allow multiple NULLs, so this still permits rows where
-- sns_message_id is NULL (while deduping non-NULL MessageIds).

DROP INDEX IF EXISTS alarm_notifications_topic_msg_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS alarm_notifications_topic_msg_uidx
  ON alarm_notifications(topic_arn, sns_message_id);

