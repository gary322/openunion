import { db } from '../src/db/client.js';
import { getPayout, markPayoutStatus } from '../src/store.js';
import { deleteArtifactObject, scanArtifactObject } from '../src/storage.js';
import { getPaymentProvider } from '../src/payments/provider.js';
import { runVerifierGateway } from '../src/verification/gateway.js';
import { nanoid } from 'nanoid';
import {
  baseUsdcAddress,
  centsToUsdcBaseUnits,
  encodePayoutSplitterCallV2,
  evmChainId,
  getLatestBlockNumber,
  getPendingNonce,
  getTransactionReceipt,
  computePayoutSplitCents,
  proofworkFeeBps,
  proofworkFeeWallet,
  rpcCall,
  signAndBroadcastSplitterTx,
} from '../src/payments/crypto/baseUsdc.js';
import { KmsEvmSigner } from '../src/payments/crypto/kmsSigner.js';
import { PrivateKeyEvmSigner, requireLocalPrivateKey } from '../src/payments/crypto/privateKeySigner.js';
import { inc } from '../src/metrics.js';

const API_BASE_URL = (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const VERIFIER_TOKEN = process.env.VERIFIER_TOKEN ?? 'pw_vf_internal';

export async function handleVerificationRequested(payload: any) {
  const submissionId = payload?.submissionId as string | undefined;
  const attemptNo = Number(payload?.attemptNo ?? 1);
  if (!submissionId) throw new Error('missing_submissionId');

  const verifierInstanceId = process.env.VERIFIER_INSTANCE_ID ?? `verifier-${process.pid}`;

  const claimResp = await fetch(`${API_BASE_URL}/api/verifier/claim`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${VERIFIER_TOKEN}`,
    },
    body: JSON.stringify({
      submissionId,
      attemptNo,
      messageId: `msg_${Date.now()}`,
      idempotencyKey: `idem_${submissionId}_${attemptNo}`,
      verifierInstanceId,
      claimTtlSec: 600,
    }),
  });
  if (!claimResp.ok) {
    throw new Error(`claim_failed:${claimResp.status}`);
  }
  const claim = (await claimResp.json()) as any;

  const gateway = await runVerifierGateway({
    verificationId: claim.verificationId,
    submissionId,
    attemptNo,
    jobSpec: claim.jobSpec,
    submission: claim.submission,
  });

  const verdictResp = await fetch(`${API_BASE_URL}/api/verifier/verdict`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${VERIFIER_TOKEN}`,
    },
    body: JSON.stringify({
      verificationId: claim.verificationId,
      claimToken: claim.claimToken,
      submissionId,
      jobId: claim.jobSpec?.jobId,
      attemptNo,
      verdict: gateway.verdict,
      reason: gateway.reason,
      scorecard: gateway.scorecard,
      evidenceArtifacts: gateway.evidenceArtifacts ?? claim.submission?.artifactIndex ?? [],
      runMetadata: { worker: 'verification-runner', ...(gateway.runMetadata ?? {}) },
    }),
  });
  if (!verdictResp.ok) {
    throw new Error(`verdict_failed:${verdictResp.status}`);
  }
}

export async function handlePayoutRequested(payload: any) {
  const payoutId = payload?.payoutId as string | undefined;
  if (!payoutId) throw new Error('missing_payoutId');
  const payout = await getPayout(payoutId);
  if (!payout) throw new Error('payout_not_found');
  if (payout.status === 'paid') return;

  const providerName = process.env.PAYMENTS_PROVIDER ?? 'mock';

  // Determine per-org platform fee settings for this payout (best-effort lookup).
  const orgFeeRow = await db
    .selectFrom('payouts')
    .innerJoin('submissions', 'submissions.id', 'payouts.submission_id')
    .innerJoin('jobs', 'jobs.id', 'submissions.job_id')
    .innerJoin('bounties', 'bounties.id', 'jobs.bounty_id')
    .innerJoin('orgs', 'orgs.id', 'bounties.org_id')
    .select([
      'orgs.id as org_id',
      'orgs.platform_fee_bps as platform_fee_bps',
      'orgs.platform_fee_wallet_address as platform_fee_wallet_address',
    ])
    .where('payouts.id', '=', payoutId)
    .executeTakeFirst();

  const platformFeeBpsVal = Number((orgFeeRow as any)?.platform_fee_bps ?? 0);
  const platformFeeWalletVal = ((orgFeeRow as any)?.platform_fee_wallet_address as string | null) ?? null;
  if (!Number.isFinite(platformFeeBpsVal) || platformFeeBpsVal < 0 || platformFeeBpsVal > 10_000) {
    throw new Error('invalid_platform_fee_bps');
  }
  if (platformFeeBpsVal > 0 && !platformFeeWalletVal) {
    throw new Error('platform_fee_wallet_missing');
  }

  const pwBps = proofworkFeeBps();
  // For off-chain providers we record fees and let treasury accounting handle the split.
  const pwWalletMaybe = process.env.PROOFWORK_FEE_WALLET_BASE ?? process.env.PLATFORM_FEE_WALLET_BASE ?? null;
  const split = computePayoutSplitCents(payout.amountCents, { platformFeeBps: platformFeeBpsVal, proofworkFeeBps: pwBps });
  const netCents = split.netCents;
  const platformFeeCents = split.platformFeeCents;
  const proofworkFeeCents = split.proofworkFeeCents;

  if (providerName === 'crypto_base_usdc' || providerName === 'crypto_evm_local') {
    const pwWallet = proofworkFeeWallet();
    const chainId = evmChainId();
    const signer =
      providerName === 'crypto_base_usdc'
        ? new KmsEvmSigner({ keyId: (() => {
            const kmsKeyId = process.env.KMS_PAYOUT_KEY_ID;
            if (!kmsKeyId) throw new Error('KMS_PAYOUT_KEY_ID not configured');
            return kmsKeyId;
          })() })
        : new PrivateKeyEvmSigner(requireLocalPrivateKey());

    const workerRow = await db.selectFrom('workers').select(['payout_address', 'payout_chain']).where('id', '=', payout.workerId).executeTakeFirst();
    const workerAddress = workerRow?.payout_address ?? null;
    const workerChain = workerRow?.payout_chain ?? null;
    if (!workerAddress || workerChain !== 'base') throw new Error('worker_payout_address_missing');

    const netUnits = centsToUsdcBaseUnits(netCents);
    const platformFeeUnits = centsToUsdcBaseUnits(platformFeeCents);
    const proofworkFeeUnits = centsToUsdcBaseUnits(proofworkFeeCents);

    const token = baseUsdcAddress();
    const data = encodePayoutSplitterCallV2({
      token,
      worker: workerAddress,
      platform: platformFeeCents > 0 ? platformFeeWalletVal! : '0x0000000000000000000000000000000000000000',
      proofwork: pwWallet,
      net: netUnits,
      platformFee: platformFeeUnits,
      proofworkFee: proofworkFeeUnits,
    });

    const from = await signer.getAddress();

    const gasLimit = BigInt(process.env.BASE_GAS_LIMIT ?? '250000');
    const maxPriorityFeePerGas =
      process.env.BASE_MAX_PRIORITY_FEE_PER_GAS_WEI ? BigInt(process.env.BASE_MAX_PRIORITY_FEE_PER_GAS_WEI) : BigInt(await rpcCall('eth_maxPriorityFeePerGas', []));
    const gasPrice = BigInt(await rpcCall('eth_gasPrice', []));
    const maxFeePerGas = process.env.BASE_MAX_FEE_PER_GAS_WEI ? BigInt(process.env.BASE_MAX_FEE_PER_GAS_WEI) : gasPrice * 2n;

    // Broadcast transaction and persist transfer legs atomically.
    await db.transaction().execute(async (trx) => {
      // Lock/allocate nonce
      const nonceRow = await trx
        .selectFrom('crypto_nonces')
        .selectAll()
        .where('chain_id', '=', chainId)
        .where('from_address', '=', from)
        .forUpdate()
        .executeTakeFirst();

      // The DB-stored nonce is an optimization. On local chains (and after restores), the chain nonce
      // can be behind the stored value. Always reconcile with the chain's pending nonce.
      const chainPending = await getPendingNonce(from);
      const stored = nonceRow ? BigInt(nonceRow.next_nonce as any) : null;
      const nonce = stored === null ? chainPending : stored > chainPending ? chainPending : stored < chainPending ? chainPending : stored;

      const { txHash } = await signAndBroadcastSplitterTx({
        signer,
        chainId,
        nonce,
        gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
        data,
      });

      // Persist next nonce
      if (nonceRow) {
        await trx
          .updateTable('crypto_nonces')
          .set({ next_nonce: (nonce + 1n).toString(), updated_at: new Date() })
          .where('chain_id', '=', chainId)
          .where('from_address', '=', from)
          .execute();
      } else {
        await trx
          .insertInto('crypto_nonces')
          .values({ chain_id: chainId, from_address: from, next_nonce: (nonce + 1n).toString(), updated_at: new Date() })
          .execute();
      }

      const now = new Date();

      // Update payout metadata (gross is amount_cents; store net+fee split)
      await trx
        .updateTable('payouts')
        .set({
          provider: providerName,
          provider_ref: txHash,
          payout_chain: 'base',
          net_amount_cents: netCents,
          platform_fee_cents: platformFeeCents,
          platform_fee_bps: platformFeeBpsVal,
          platform_fee_wallet_address: platformFeeWalletVal,
          proofwork_fee_cents: proofworkFeeCents,
          proofwork_fee_bps: pwBps,
          proofwork_fee_wallet_address: pwWallet,
          updated_at: now,
        })
        .where('id', '=', payoutId)
        .execute();

      // Upsert transfer legs
      await trx
        .insertInto('payout_transfers')
        .values({
          id: nanoid(12),
          payout_id: payoutId,
          kind: 'net',
          chain_id: chainId,
          from_address: from,
          to_address: workerAddress,
          token: 'usdc',
          amount_base_units: netUnits.toString(),
          tx_hash: txHash,
          tx_nonce: nonce.toString(),
          status: 'broadcast',
          broadcast_at: now,
          confirmed_at: null,
          failure_reason: null,
          created_at: now,
        })
        .onConflict((oc) => oc.columns(['payout_id', 'kind']).doUpdateSet({ tx_hash: txHash, tx_nonce: nonce.toString(), status: 'broadcast', broadcast_at: now }))
        .execute();

      if (platformFeeCents > 0) {
        await trx
          .insertInto('payout_transfers')
          .values({
            id: nanoid(12),
            payout_id: payoutId,
            kind: 'platform_fee',
            chain_id: chainId,
            from_address: from,
            to_address: platformFeeWalletVal!,
            token: 'usdc',
            amount_base_units: platformFeeUnits.toString(),
            tx_hash: txHash,
            tx_nonce: nonce.toString(),
            status: 'broadcast',
            broadcast_at: now,
            confirmed_at: null,
            failure_reason: null,
            created_at: now,
          })
          .onConflict((oc) => oc.columns(['payout_id', 'kind']).doUpdateSet({ tx_hash: txHash, tx_nonce: nonce.toString(), status: 'broadcast', broadcast_at: now }))
          .execute();
      }

      if (proofworkFeeCents > 0) {
        await trx
          .insertInto('payout_transfers')
          .values({
            id: nanoid(12),
            payout_id: payoutId,
            kind: 'proofwork_fee',
            chain_id: chainId,
            from_address: from,
            to_address: pwWallet,
            token: 'usdc',
            amount_base_units: proofworkFeeUnits.toString(),
            tx_hash: txHash,
            tx_nonce: nonce.toString(),
            status: 'broadcast',
            broadcast_at: now,
            confirmed_at: null,
            failure_reason: null,
            created_at: now,
          })
          .onConflict((oc) => oc.columns(['payout_id', 'kind']).doUpdateSet({ tx_hash: txHash, tx_nonce: nonce.toString(), status: 'broadcast', broadcast_at: now }))
          .execute();
      }

      // Enqueue confirmation check (idempotent)
      await trx
        .insertInto('outbox_events')
        .values({
          id: nanoid(12),
          topic: 'payout.confirm.requested',
          idempotency_key: `payout_confirm:${payoutId}`,
          payload: { payoutId },
          status: 'pending',
          attempts: 0,
          available_at: new Date(Date.now() + 30_000),
          locked_at: null,
          locked_by: null,
          last_error: null,
          created_at: now,
          sent_at: null,
        })
        .onConflict((oc) => oc.columns(['topic', 'idempotency_key']).doNothing())
        .execute();
    });

    return;
  }

  // Default: mock/http provider
  const provider = getPaymentProvider();
  // Persist fee split metadata even for non-crypto providers (fees are withheld from worker payout).
  await db
    .updateTable('payouts')
    .set({
      net_amount_cents: netCents,
      platform_fee_cents: platformFeeCents,
      platform_fee_bps: platformFeeBpsVal,
      platform_fee_wallet_address: platformFeeWalletVal,
      proofwork_fee_cents: proofworkFeeCents,
      proofwork_fee_bps: pwBps,
      proofwork_fee_wallet_address: pwWalletMaybe,
      updated_at: new Date(),
    })
    .where('id', '=', payoutId)
    .execute();

  const res = await provider.createPayout({ payoutId, amountCents: netCents, workerId: payout.workerId, currency: 'usd' });
  if (res.status === 'paid') {
    await markPayoutStatus(payoutId, 'paid', { provider: res.provider, providerRef: res.providerRef });
    try {
      if (platformFeeCents) inc('platform_fee_cents_total', platformFeeCents);
      if (proofworkFeeCents) inc('proofwork_fee_cents_total', proofworkFeeCents);
    } catch {
      // ignore
    }
  } else {
    await markPayoutStatus(payoutId, 'failed', { provider: res.provider, providerRef: res.providerRef });
  }
}

export async function handlePayoutConfirmRequested(payload: any) {
  const payoutId = payload?.payoutId as string | undefined;
  if (!payoutId) throw new Error('missing_payoutId');

  const payout = await getPayout(payoutId);
  if (!payout) throw new Error('payout_not_found');
  if (payout.status === 'paid' || payout.status === 'failed') return;
  const provider = payout.provider ?? 'crypto_base_usdc';

  const transfers = await db.selectFrom('payout_transfers').selectAll().where('payout_id', '=', payoutId).execute();
  if (!transfers.length) throw new Error('payout_transfers_missing');
  if (transfers.every((t: any) => t.status === 'confirmed')) {
    await markPayoutStatus(payoutId, 'paid', { provider, providerRef: transfers[0]?.tx_hash ?? null });
    try {
      const platformFee = (payout as any).platform_fee_cents ?? null;
      const proofworkFee = (payout as any).proofwork_fee_cents ?? null;
      if (typeof platformFee === 'number' && Number.isFinite(platformFee)) inc('platform_fee_cents_total', platformFee);
      if (typeof proofworkFee === 'number' && Number.isFinite(proofworkFee)) inc('proofwork_fee_cents_total', proofworkFee);
    } catch {
      // ignore
    }
    return;
  }

  const txHash = (transfers[0] as any).tx_hash as string | null;
  if (!txHash) throw new Error('tx_hash_missing');

  const receipt = await getTransactionReceipt(txHash);
  if (!receipt) throw new Error('tx_receipt_pending');

  const statusHex = String(receipt.status ?? '0x1');
  if (statusHex === '0x0') {
    const now = new Date();
    await db.updateTable('payout_transfers').set({ status: 'failed', failure_reason: 'tx_reverted', confirmed_at: now }).where('payout_id', '=', payoutId).execute();
    await markPayoutStatus(payoutId, 'failed', { provider, providerRef: txHash });
    return;
  }

  const blockHex = String(receipt.blockNumber ?? '0x0');
  const block = BigInt(blockHex);
  const latest = await getLatestBlockNumber();
  const conf = latest >= block ? latest - block + 1n : 0n;
  const required = BigInt(Number(process.env.BASE_CONFIRMATIONS_REQUIRED ?? 5));
  if (conf < required) throw new Error('tx_not_enough_confirmations');

  const now = new Date();
  await db.updateTable('payout_transfers').set({ status: 'confirmed', confirmed_at: now }).where('payout_id', '=', payoutId).execute();
  await markPayoutStatus(payoutId, 'paid', { provider, providerRef: txHash });
}

export async function handleArtifactDeleteRequested(payload: any) {
  const artifactId = payload?.artifactId as string | undefined;
  const retentionJobId = payload?.retentionJobId as string | undefined;
  if (!artifactId) throw new Error('missing_artifactId');

  await deleteArtifactObject(artifactId);

  if (retentionJobId) {
    await db
      .updateTable('retention_jobs')
      .set({ status: 'finished', finished_at: new Date() })
      .where('id', '=', retentionJobId)
      .execute();
  }
}

export async function handleArtifactScanRequested(payload: any) {
  const artifactId = payload?.artifactId as string | undefined;
  if (!artifactId) throw new Error('missing_artifactId');
  try {
    await scanArtifactObject(artifactId);
    inc('artifact_scanned_total', 1);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (msg.includes('malware') || msg.includes('infected') || msg.includes('blocked')) {
      inc('artifact_blocked_total', 1);
    }
    throw err;
  }
}
