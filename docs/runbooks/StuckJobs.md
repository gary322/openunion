# Stuck jobs / troubleshooting runbook

## Symptoms
- Workers are stuck in `claimed` but never complete.
- `/api/jobs/next` returns `idle` even though you believe work exists.
- Verifications never finish.

## Checklist

### 1) Check worker intake pause
- `UNIVERSAL_WORKER_PAUSE`
- `MAX_VERIFIER_BACKLOG` and `proofwork_verifier_backlog`
- `MAX_OUTBOX_PENDING_AGE_SEC` and `proofwork_outbox_pending_age_seconds`
- `MAX_ARTIFACT_SCAN_BACKLOG_AGE_SEC` and `proofwork_artifact_scan_backlog_age_seconds`

### 2) Check leases
- A job is only claimable if:
  - `status=open`, or
  - `status=claimed` with an expired lease.

Manual lease reaper (ops/test helper):
- `POST /api/internal/reap-leases`

### 3) Check stale jobs (freshness SLA)
If `task_descriptor.freshness_sla_sec` is set, jobs may become unclaimable:
- `GET /health/metrics` → `proofwork_jobs_stale`

### 4) Check artifacts and scanning
- If storage is `s3`, uploads must call `POST /api/uploads/complete` to enqueue scanning.
- If scanner lags, artifact attachment on submit fails with `artifact_not_scanned`.

### 5) Check DLQ
If outbox events exceed `MAX_OUTBOX_ATTEMPTS`, they enter deadletter.
- See `docs/runbooks/DLQ.md`

### 6) Check verifier gateway
- `VERIFIER_GATEWAY_URL` is reachable from verification workers.
- `GET <gateway>/health` returns ok.
- See `docs/runbooks/VerifierGateway.md`

