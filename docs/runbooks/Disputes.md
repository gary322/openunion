# Disputes runbook (1-day hold + auto-refund)

Disputes are a **buyer-side safety rail**:
- Payouts are held for a configurable window (`bounties.dispute_window_sec`).
- If the buyer opens a dispute during the hold window, the payout is blocked.
- Default posture: after the hold window elapses, the system **auto-refunds** the buyer
  **minus the Proofwork fee**.

## Key invariants
- Default dispute window in production: **86400 seconds (1 day)**.
  - In dev/test the default is `0` (no hold) unless set explicitly.
  - Override with `DEFAULT_DISPUTE_WINDOW_SEC`.
- Refund amount:
  - `refund_cents = payout.amount_cents - payout.proofwork_fee_cents`
  - Platform fee is **not** charged on refunds (platform fees are only paid when the payout is paid).
- Dispute window enforcement:
  - A dispute can only be created if `payout.hold_until` exists and is in the future.
- Payout execution:
  - The `payout.requested` outbox event is scheduled at `hold_until` by default.
  - Creating a dispute marks `payout.requested` as `sent` so it cannot execute while the dispute is open.

## APIs

Buyer (org):
- `GET /api/org/disputes`
- `POST /api/org/disputes` (open)
- `POST /api/org/disputes/:disputeId/cancel` (cancel)

Admin:
- `GET /api/admin/disputes`
- `POST /api/admin/disputes/:disputeId/resolve` with `{ resolution: "refund"|"uphold" }`

## UIs
- Buyer portal: `/buyer/` (Disputes card)
- Admin disputes: `/admin/disputes.html`
- Admin payouts: `/admin/payouts.html` (see blocked_reason, retry)

## Operational workflow

### Buyer opens a dispute
1) Buyer opens dispute via Buyer portal or `POST /api/org/disputes`.
2) System sets `payouts.blocked_reason='dispute_open'`.
3) System schedules `dispute.auto_refund.requested` at `payout.hold_until`.

### Cancel a dispute (buyer)
If the dispute is cancelled before hold expiry:
1) Dispute becomes `cancelled`.
2) Payout is unblocked.
3) Payout execution is re-scheduled at `max(now, hold_until)`.

### Admin resolves a dispute
- `refund`:
  - Credits the buyer org billing account by `refund_cents`.
  - Marks payout `refunded`.
  - Marks submission `payout_status='reversed'`.
- `uphold`:
  - Unblocks payout and re-schedules payout execution at `max(now, hold_until)`.

### Auto-refund (system)
At `hold_until`, the payout worker processes `dispute.auto_refund.requested` and executes the same logic as an admin refund.

## Debugging

### Check dispute + payout state
```sql
SELECT * FROM disputes WHERE id = '<disputeId>';
SELECT * FROM payouts WHERE id = '<payoutId>';
SELECT * FROM outbox_events WHERE idempotency_key IN ('payout:<payoutId>', 'dispute:auto_refund:<disputeId>');
```

### Common failure cases
- `dispute_window_disabled`: bounty has `dispute_window_sec=0` so payouts are immediate.
- `dispute_window_expired`: hold window already elapsed.
- `payout_already_paid`: payout completed before dispute was opened (should be rare if hold window is non-zero).

