# Monitoring (dashboards + SLO alarms)

This repo exposes low-cardinality health gauges at `GET /health/metrics` (see `docs/runbooks/SLOs.md`).

For AWS environments, the recommended baseline is:

1. Enable alert delivery (`CloudWatch Alarm -> SNS -> SQS -> alarm_inbox`): `docs/runbooks/Alerting.md`
2. Enable an internal metrics reporter worker that emits **CloudWatch Embedded Metric Format (EMF)** logs
3. Create a minimal CloudWatch dashboard + SLO alarms wired to the alarms SNS topic

## One command (AWS)

This is a best-effort, idempotent script that:
- ensures `/ecs/<env>/ops-metrics` log group exists
- creates/updates an ECS service `<prefix>-ops-metrics` that runs `workers/ops-metrics-runner.ts`
- creates SLO alarms on the resulting CloudWatch metrics
- creates a minimal ops dashboard

```bash
# Staging
tsx scripts/ops/monitoring_enable_env.ts --env staging

# Production
tsx scripts/ops/monitoring_enable_env.ts --env production
```

## Where it shows up

- CloudWatch Metrics namespace: `Proofwork`
- Dashboard: `<prefix>-ops` (default: `proofwork-staging-ops`, `proofwork-prod-ops`)
- Admin UI alerts (if alarm inbox enabled): `/admin/alerts.html`

