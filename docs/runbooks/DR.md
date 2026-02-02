# Disaster recovery (DR) runbook

This is a minimal, practical procedure for restoring Proofwork after a DB or storage incident.

## Postgres backup
Recommended: automated daily snapshots + WAL (RDS/Cloud SQL).

Manual backup:
```bash
pg_dump --format=custom --no-owner --file proofwork.dump "$DATABASE_URL"
```

## Postgres restore
1) Create a fresh database.
2) Restore:
```bash
pg_restore --no-owner --clean --if-exists --dbname "$DATABASE_URL" proofwork.dump
```
3) Run migrations (safe/idempotent via `schema_migrations`):
```bash
npm run db:migrate
```

## Object storage (S3/R2/MinIO)
Artifacts may exist in:
- staging bucket
- clean bucket
- quarantine bucket

Recommended:
- Enable bucket versioning (where possible).
- Enable lifecycle policies for retention (`ARTIFACT_TTL_DAYS`).

If restoring storage from backup:
- Ensure bucket names/credentials match environment variables.
- Verify a sample `GET /api/artifacts/:id/download` works.

## Retention and replay safety
- Retention workers must be safe to re-run (deletes are idempotent).
- Outbox may contain pending events after restore. Monitor:
  - `proofwork_outbox_pending`
  - `proofwork_outbox_pending_age_seconds`
  - `proofwork_outbox_deadletter`

## Validation checklist after restore
- `GET /health` returns `{ok:true}`
- `GET /health/metrics` renders
- Can create a bounty, publish, claim, submit, verify, pay (smoke test)

