# Outbox DLQ runbook

## Symptoms
- `proofwork_outbox_deadletter{topic="..."} > 0`
- Background actions stop progressing (payouts/scans/verifications not completing).

## Immediate checks
- Verify DB connectivity from workers.
- Check worker logs for the specific error string in `outbox_events.last_error`.
- Ensure dependent services are up:
  - verifier gateway (`VERIFIER_GATEWAY_URL`)
  - storage (S3/MinIO) for scanning/deletion
  - payment provider / Base RPC for payouts

## How to inspect DLQ rows
Use SQL:

```sql
SELECT id, topic, attempts, last_error, payload, created_at
FROM outbox_events
WHERE status='deadletter'
ORDER BY created_at DESC
LIMIT 50;
```

## How to retry safely
1) Fix the underlying issue (misconfig, service outage, missing bucket, etc).
2) Move rows back to pending:

```sql
UPDATE outbox_events
SET status='pending', locked_at=NULL, locked_by=NULL, last_error=NULL, available_at=now()
WHERE status='deadletter' AND topic='payout.requested';
```

3) Watch `proofwork_outbox_pending` and worker logs to confirm progress.

## When NOT to retry
- Deterministic validation failures (e.g. missing required wallet / missing artifact) unless the data was corrected.

