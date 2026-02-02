# SLOs (v0)

This repo exposes a small set of **low-cardinality health metrics** at `GET /health/metrics`.

Use these SLOs as a starting point for production. Tune per environment and workload.

## SLO 1: Job wait time to claim
- **Goal**: P95 time from `jobs.created_at` to `jobs.lease_*` is < X minutes.
- **Practical proxy (v0)**:
  - Track `jobs_open` volume per task type (admin apps summary) and ensure it is not persistently growing.
  - Alert when `proofwork_jobs_stale` > 0 for freshness-sensitive task types.

## SLO 2: Verification turnaround
- **Goal**: P95 time from submission to `verifications.finished` is < X minutes.
- **Metrics**:
  - `proofwork_verifier_backlog` (gauge)
  - `proofwork_verifier_backlog_age_seconds` (gauge)
- **Alert examples**:
  - `proofwork_verifier_backlog_age_seconds > 300` for 10m (verification stuck)

## SLO 3: Artifact scan backlog
- **Goal**: P95 time from artifact uploaded to scanned is < X minutes.
- **Metrics**:
  - `proofwork_artifact_scan_backlog_age_seconds` (gauge)
  - `proofwork_artifacts{status="uploaded"}` (gauge)
- **Alert examples**:
  - `proofwork_artifact_scan_backlog_age_seconds > 300` for 10m (scanner stuck)

## SLO 4: Outbox lag (all critical topics)
- **Goal**: outbox `pending` age stays < X minutes for critical topics.
- **Metrics**:
  - `proofwork_outbox_pending{topic="..."}` (gauge)
  - `proofwork_outbox_pending_age_seconds{topic="..."}` (gauge)
  - `proofwork_outbox_deadletter{topic="..."}` (gauge)
- **Alert examples**:
  - `proofwork_outbox_pending_age_seconds{topic="verification.requested"} > 120` for 10m
  - `proofwork_outbox_deadletter > 0` (paging)

## SLO 5: Payout completion
- **Goal**: payouts move from `pending` → `paid` within X minutes/hours (depending on provider).
- **Metrics**:
  - `proofwork_payouts{status="pending"|"paid"|"failed"}`
  - `proofwork_payout_failed_total` (counter)
- **Alert examples**:
  - `proofwork_payouts{status="failed"} > 0` for 5m

## Operational notes
- If you see sustained queue age growth, use:
  - `UNIVERSAL_WORKER_PAUSE=true` (stop intake)
  - `MAX_*_AGE_SEC` (auto-pause thresholds)
  - `ENABLE_TASK_DESCRIPTOR=false` (rollback descriptor exposure/intake)

