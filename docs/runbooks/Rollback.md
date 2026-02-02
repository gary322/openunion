# Rollback / kill-switch runbook

When production is unhealthy (verifier lag, scanner failures, bad descriptors, payout issues), use the following levers.

## Stop new work
- `UNIVERSAL_WORKER_PAUSE=true`
  - Immediately returns `state=idle` from `GET /api/jobs/next`

## Automatically stop when queues lag
Configure age-based backpressure (seconds). When exceeded, `/api/jobs/next` returns idle.
- `MAX_VERIFIER_BACKLOG_AGE_SEC`
- `MAX_OUTBOX_PENDING_AGE_SEC`
- `MAX_ARTIFACT_SCAN_BACKLOG_AGE_SEC`

## Disable descriptor feature (revert to legacy)
- `ENABLE_TASK_DESCRIPTOR=false`
  - Rejects bounty creation with `taskDescriptor`
  - Hides `taskDescriptor` from worker job specs and verifier claims

## Tighten uploads immediately
- `BLOCKED_UPLOAD_CONTENT_TYPES=...`
  - Rejects presign for dangerous content types (e.g. `application/x-msdownload`)
- Reduce `MAX_UPLOAD_BYTES` for emergency mitigation.

## Payments mitigation
- Switch provider:
  - `PAYMENTS_PROVIDER=mock` (dev/staging only)
  - `PAYMENTS_PROVIDER=http` (external payout service)
  - `PAYMENTS_PROVIDER=crypto_base_usdc` (on-chain payouts)

## Notes
- All of the above are **runtime env** changes (roll services to apply).
- DB migrations are additive; rollback is primarily flag-driven.

