# Alerting (CloudWatch alarms → SNS notifications)

Proofwork's Terraform module creates a small set of CloudWatch alarms (ALB 5xx/latency, ECS CPU, RDS CPU/storage).

To actually **notify humans**, alarms need an SNS topic in `alarm_actions`.

## Option 0: Internal alarm inbox (recommended baseline)

If you enable the alarm inbox, Terraform wires:

- CloudWatch Alarm → SNS topic (`alarm_actions`)
- SNS → SQS subscription (persistent)
- ECS worker (`alarm_inbox`) drains SQS and stores notifications in Postgres
- Admin UI: `/admin/alerts.html`

Terraform:
- Ensure `alarm_sns_topic_arn` is set (BYO topic) **or** `create_alarm_sns_topic=true`
- Ensure `enable_alarm_inbox=true`

Verification:
- Confirm the `alarm_inbox` ECS service is running
- Force a CloudWatch alarm into `ALARM` state (or use the canary script below)
- Refresh `/admin/alerts.html` and confirm a row appears

## Option 1: Bring your own SNS topic (BYO)

- Set Terraform variable: `alarm_sns_topic_arn=arn:aws:sns:...`
- Ensure the SNS topic has your desired subscriptions (email/slack/webhook).

## Option 2: Let Terraform create the SNS topic (recommended)

Set:
- `create_alarm_sns_topic=true`
- Optional: `alarm_sns_topic_name`
- Subscriptions:
  - `alarm_email_subscriptions=["you@example.com"]` (requires email confirmation click)
  - `alarm_https_subscriptions=["https://..."]` (PagerDuty/Opsgenie/webhook)

After apply, Terraform outputs `alarm_sns_topic_arn` (effective).

## E2E test (no email required): SNS → SQS canary

Email subscriptions require manual confirmation. For an automated proof that the pipeline works end-to-end, you can run:

```bash
# One-step enable + canary (no Terraform apply; creates SNS topic if missing, wires alarms, enables alarm inbox ECS worker).
tsx scripts/ops/alerting_enable_env.ts --env staging
tsx scripts/ops/alerting_enable_env.ts --env production

# Staging
bash scripts/ops/test_alarm_notifications.sh staging arn:aws:sns:us-east-1:542672133063:proofwork-staging-alarms us-east-1

# Prod
bash scripts/ops/test_alarm_notifications.sh prod arn:aws:sns:us-east-1:542672133063:proofwork-prod-alarms us-east-1
```

This creates a temporary SQS queue, subscribes it to the alarms SNS topic, forces a CloudWatch alarm into ALARM state,
verifies a notification is delivered, and then cleans everything up.
