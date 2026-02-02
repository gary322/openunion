# Deploy (staging → production) checklist

### Pre-flight
- **Secrets configured** in Secrets Manager (or your secret store):
  - `DATABASE_URL`, `WORKER_TOKEN_PEPPER`, `BUYER_TOKEN_PEPPER`, `SESSION_SECRET`
  - `VERIFIER_TOKEN_HASH` + `VERIFIER_TOKEN` (token preimage distributed to internal verifier workers/gateway)
  - `ADMIN_TOKEN_HASH`
  - Storage buckets + credentials (S3/R2) or MinIO (dev only)
  - Payments secrets (Stripe) and/or crypto payout secrets (KMS key id, Base RPC, splitter address, Proofwork fee wallet)
- **Migrations**: plan a migration run window (see `docs/runbooks/Migrations.md`).
- **Object storage buckets exist**: staging/clean/quarantine (no public bucket ACLs).
- **Workers**: decide desired counts for outbox/verification/payout/scanner/retention and autoscaling ranges.
- **Feature flags / safety levers**:
  - `ENABLE_TASK_DESCRIPTOR` (default true)
  - `UNIVERSAL_WORKER_PAUSE` (emergency stop)
  - `UNIVERSAL_WORKER_CANARY_PERCENT` (canary rollout for universal worker claims)
  - `MAX_*_AGE_SEC` backpressure knobs for queue lag
  - `MIN_PAYOUT_CENTS` floor (optional)
  - `MAX_PROOFWORK_FEE_BPS` cap (crypto payouts)

### Deploy steps (ECS/Fargate)
- Build/push images:
  - API/worker image (root `Dockerfile`)
  - Verifier gateway image (`services/verifier-gateway/Dockerfile`)
- Apply Terraform for the target environment.
- Run the **migration task** (ECS task definition output includes migrate task ARN).
- Deploy/roll services:
  - API behind ALB
  - Verifier gateway
  - Workers (outbox/verification/payout/scanner/retention)
- Verify health:
  - `GET /health` on API via ALB
  - worker health ports: `GET /health` on each worker task
  - verifier gateway `GET /health`

### Post-deploy validation
- Run a staged smoke test:
  - buyer creates bounty → worker submits → verifier completes → payout requested/confirmed
- Confirm SLO health signals (see `docs/runbooks/SLOs.md`):
  - verifier backlog age
  - outbox pending age
  - artifact scan backlog age
  - stale jobs gauge (freshness)
- Confirm dashboards/alarms are green:
  - ALB 5xx, latency alarms
  - ECS CPU alarms
  - RDS CPU + FreeStorageSpace alarms
- Validate WAF (if enabled) and rate limits.
