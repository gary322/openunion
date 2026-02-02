# Payouts runbook (Base USDC + per-org platform fee + Proofwork fee)

## Symptoms
- `payouts.status='pending'` grows
- `proofwork_outbox_pending{topic="payout.confirm.requested"}` grows
- Payout marked `failed` unexpectedly

## Required config (crypto payouts)
- `PAYMENTS_PROVIDER=crypto_base_usdc`
- `BASE_RPC_URL`
- `KMS_PAYOUT_KEY_ID`
- `BASE_PAYOUT_SPLITTER_ADDRESS`
- `PROOFWORK_FEE_BPS` (default 100 for 1%)
- `PROOFWORK_FEE_WALLET_BASE`

Per-org platform fee (optional):
- `orgs.platform_fee_bps` and `orgs.platform_fee_wallet_address` are configured by the buyer org (see Buyer portal “Platform fee” card or `PUT /api/org/platform-fee`).

## How to inspect a payout
```sql
SELECT * FROM payouts WHERE id = '<payoutId>';
SELECT * FROM payout_transfers WHERE payout_id = '<payoutId>' ORDER BY kind;
```

## Common failures
- `worker_payout_address_missing`: worker must set `/api/worker/payout-address`
- `rpc_error:*`: Base RPC unavailable / rate limited
- `tx_reverted`: splitter reverted (often missing USDC allowance or insufficient balance)

## Recovery steps
1) Fix root cause (fund treasury, set allowance, fix RPC).
2) For stuck confirmations: requeue confirm event:
```sql
UPDATE outbox_events
SET status='pending', locked_at=NULL, locked_by=NULL, last_error=NULL, available_at=now()
WHERE topic='payout.confirm.requested' AND payload->>'payoutId'='<payoutId>';
```
3) For failed payouts: decide whether to create a new payout or manually mark failed.

## Platform fee verification
- Each payout should have:
  - `payout_transfers.kind='net'` to worker address
  - `payout_transfers.kind='platform_fee'` to the org platform wallet (if configured)
  - `payout_transfers.kind='proofwork_fee'` to the Proofwork fee wallet
- `grossCents = netCents + platformFeeCents + proofworkFeeCents` per payout row.
