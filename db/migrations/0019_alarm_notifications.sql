-- Alarm notification inbox (SNS -> SQS -> DB)
--
-- This is a lightweight ops surface so CloudWatch alarms actually reach humans,
-- even before Slack/email subscriptions are configured.

CREATE TABLE IF NOT EXISTS alarm_notifications (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  topic_arn TEXT NOT NULL,
  sns_message_id TEXT,
  alarm_name TEXT,
  old_state_value TEXT,
  new_state_value TEXT,
  state_reason TEXT,
  state_change_time TIMESTAMPTZ,
  raw_json JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deduplicate SNS deliveries (SQS is at-least-once). SNS MessageId is stable per publish.
CREATE UNIQUE INDEX IF NOT EXISTS alarm_notifications_topic_msg_uidx
  ON alarm_notifications(topic_arn, sns_message_id)
  WHERE sns_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS alarm_notifications_received_at_idx ON alarm_notifications(received_at DESC);
CREATE INDEX IF NOT EXISTS alarm_notifications_alarm_name_idx ON alarm_notifications(alarm_name);

