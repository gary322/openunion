# Payouts runbook (Base USDC + per-org platform fee + Proofwork fee)

## Symptoms
- `payouts.status='pending'` grows
- `proofwork_outbox_pending{topic="payout.confirm.requested"}` grows
- Payout marked `failed` unexpectedly

## Worker-side visibility (OpenClaw)

If you run the OpenClaw Proofwork worker plugin, workers can check:
- `/proofwork payouts pending|paid|failed|refunded`
- `/proofwork earnings`
- `/proofwork payout status` (to verify payout address)

## Operator smoke checklist (payout pipeline)

Before debugging individual payouts, confirm:
- `workers/outbox-dispatcher.ts` is running
- `workers/payout-runner.ts` is running
- the payout signer is funded (Base ETH for gas + Base USDC for payouts)
- splitter allowance exists (see “Approve USDC allowance for the splitter” below)
- `PROOFWORK_FEE_WALLET_BASE` is configured

## Required config (crypto payouts)
- `PAYMENTS_PROVIDER=crypto_base_usdc`
- `BASE_RPC_URL`
- `KMS_PAYOUT_KEY_ID`
- `BASE_PAYOUT_SPLITTER_ADDRESS`
- `PROOFWORK_FEE_BPS` (default 100 for 1%)
- `PROOFWORK_FEE_WALLET_BASE`

## Pinned rollout matrix (staging -> production)
Use this exact matrix for Base USDC rollout. Any drift should block deployment.

| Setting | Staging | Production |
| --- | --- | --- |
| `PAYMENTS_PROVIDER` | `crypto_base_usdc` | `crypto_base_usdc` |
| `BASE_RPC_URL` | `https://mainnet.base.org` | `https://mainnet.base.org` |
| `PROOFWORK_FEE_BPS` | `100` | `100` |
| `PROOFWORK_FEE_WALLET_BASE` | `0xC9862D6326E93b818d7C735Dc8af6eBddD066bDF` | `0xC9862D6326E93b818d7C735Dc8af6eBddD066bDF` |
| `KMS_PAYOUT_KEY_ID` | staging KMS key id | production KMS key id |
| `BASE_PAYOUT_SPLITTER_ADDRESS` | staging splitter address | production splitter address |
| signer EVM address | `0x574586869d9C3d2312e57728b36777597044CE92` | `0xeB2206f585BBb6Cf8723bca4f1430DDD6a2b4684` |

## Release gates (must pass in order)
1) **Stage preflight:** `npm run ops:payout:preflight` passes with no failures.
2) **Stage smoke:** `npm run smoke:payout:remote` passes 3 consecutive times.
3) **Stage burn-in:** monitor 24h with no growing payout backlog and no recurring failures.
4) **Prod preflight:** `npm run ops:payout:preflight` passes against production config.
5) **Prod canary:** one small payout smoke succeeds and confirms on-chain net + fee transfers.
6) **Prod steady-state:** alerts/metrics are green for payout runner + outbox + confirmations.

### Preflight command
Run this before staging and production rollout:
```bash
npm run ops:payout:preflight -- --base-url https://<env-api-host>
```

If AWS credentials are not available in your current shell, use config-only mode:
```bash
SKIP_KMS_CHECK=1 npm run ops:payout:preflight -- --base-url https://<env-api-host>
```

Per-org platform fee (optional):
- `orgs.platform_fee_bps` and `orgs.platform_fee_wallet_address` are configured by the buyer org (see Buyer portal “Platform fee” card or `PUT /api/org/platform-fee`).

## One-time setup: deploy + approve the splitter on Base

### 1) Compile contracts
```bash
npx hardhat compile --config contracts/hardhat.config.ts
```

### 2) Deploy `PayoutSplitter` to Base
You need a **funded deployer EOA** on Base (ETH for gas).

```bash
RPC_URL=https://mainnet.base.org \\
DEPLOYER_PRIVATE_KEY=0x... \\
npx tsx contracts/scripts/deploy-splitter.ts
```

Secure option (deploy from AWS KMS key, no private key at rest):
```bash
RPC_URL=https://mainnet.base.org \\
KMS_PAYOUT_KEY_ID=... \\
npx tsx contracts/scripts/deploy-splitter-kms.ts
```

Record the output field:
- `payoutSplitter` → set this as `BASE_PAYOUT_SPLITTER_ADDRESS`.

### 3) Fund the payout signer (treasury)
The payout worker sends on-chain transactions from the KMS-derived EVM address (`KMS_PAYOUT_KEY_ID`).

You must fund it with:
- **ETH on Base** (gas), and
- **USDC on Base** (to pay workers/platform/proofwork).

If the address has `0 ETH`, approvals/payouts will fail.

### 4) Approve USDC allowance for the splitter
The splitter uses `transferFrom(msg.sender, ...)`, so the signer must approve it once.

KMS signer approval:
```bash
BASE_RPC_URL=https://mainnet.base.org \\
BASE_PAYOUT_SPLITTER_ADDRESS=0x... \\
KMS_PAYOUT_KEY_ID=... \\
npx tsx scripts/crypto/approve_base_usdc.ts
```

Private-key signer approval (for testing only):
```bash
BASE_RPC_URL=https://mainnet.base.org \\
BASE_PAYOUT_SPLITTER_ADDRESS=0x... \\
PAYER_PRIVATE_KEY=0x... \\
npx tsx scripts/crypto/approve_base_usdc.ts
```

### 5) Turn on crypto payouts
Set/validate:
- `PAYMENTS_PROVIDER=crypto_base_usdc`
- `BASE_RPC_URL`
- `BASE_PAYOUT_SPLITTER_ADDRESS`
- `KMS_PAYOUT_KEY_ID`
- `PROOFWORK_FEE_WALLET_BASE`

Then deploy/roll the payout worker.

## How to inspect a payout
```sql
SELECT * FROM payouts WHERE id = '<payoutId>';
SELECT * FROM payout_transfers WHERE payout_id = '<payoutId>' ORDER BY kind;
```

## Common failures
- `worker_payout_address_missing`: worker has not configured a payout address yet. Payouts remain `pending` but are blocked with `payouts.blocked_reason='worker_payout_address_missing'` until the worker sets `/api/worker/payout-address`, at which point payouts are automatically requeued.
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
