import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { Contract, HDNodeWallet, JsonRpcProvider, Wallet } from 'ethers';
import { nanoid } from 'nanoid';
import { buildServer } from '../src/server.js';
import { db } from '../src/db/client.js';
import { resetStore, addPayout, addSubmission, createWorker } from '../src/store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';
const HARDHAT_PORT = 39000 + Math.floor(Math.random() * 1000);
const HARDHAT_RPC = `http://127.0.0.1:${HARDHAT_PORT}`;

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForRpc(url: string, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      });
      const json = await resp.json();
      if (json?.result) return;
    } catch {
      // ignore
    }
    await wait(250);
  }
  throw new Error('hardhat_rpc_not_ready');
}

let hardhatProc: ReturnType<typeof spawn> | undefined;
let deployed: { usdc: string; payoutSplitter: string; payerAddress: string } | undefined;

beforeAll(async () => {
  try {
    // Compile contracts once.
    execFileSync('npx', ['hardhat', 'compile', '--config', 'contracts/hardhat.config.ts'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });

    // Start Hardhat node (JSON-RPC) on a high random port to avoid collisions with any devchain.
    hardhatProc = spawn(
      'npx',
      ['hardhat', 'node', '--config', 'contracts/hardhat.config.ts', '--hostname', '127.0.0.1', '--port', String(HARDHAT_PORT)],
      {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      }
    );
    hardhatProc.stdout?.on('data', () => {});
    hardhatProc.stderr?.on('data', () => {});
    await waitForRpc(HARDHAT_RPC);

    // Use funded Hardhat account 0 as payer.
    const payer = HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, "m/44'/60'/0'/0/0");
    process.env.LOCAL_EVM_PRIVATE_KEY = payer.privateKey;
    process.env.LOCAL_EVM_RPC_URL = HARDHAT_RPC;

    // Deploy MockUSDC + PayoutSplitter and approve splitter.
    const out = execFileSync('npx', ['tsx', 'contracts/scripts/deploy-local.ts'], {
      cwd: repoRoot,
      env: { ...process.env, LOCAL_EVM_PRIVATE_KEY: payer.privateKey, LOCAL_EVM_RPC_URL: HARDHAT_RPC },
    }).toString('utf8');
    deployed = JSON.parse(out);
  } catch (err) {
    if (hardhatProc && !hardhatProc.killed) {
      hardhatProc.kill('SIGTERM');
    }
    throw err;
  }
});

afterAll(async () => {
  if (hardhatProc && !hardhatProc.killed) {
    hardhatProc.kill('SIGTERM');
  }
});

beforeEach(async () => {
  await resetStore();
});

describe('Crypto payout E2E (local chain)', () => {
  it('pays net to worker, per-org platform fee, and Proofwork fee, and marks payout paid', async () => {
    if (!deployed) throw new Error('missing_deploy');

    // Configure payout worker for local chain.
    process.env.PAYMENTS_PROVIDER = 'crypto_evm_local';
    process.env.BASE_RPC_URL = HARDHAT_RPC;
    process.env.EVM_CHAIN_ID = '31337';
    process.env.BASE_USDC_ADDRESS = deployed.usdc;
    process.env.BASE_PAYOUT_SPLITTER_ADDRESS = deployed.payoutSplitter;
    process.env.BASE_CONFIRMATIONS_REQUIRED = '1';

    // Proofwork fee = 1% (default), paid to hardhat account 2.
    process.env.PROOFWORK_FEE_BPS = '100';
    const proofworkWallet = HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, "m/44'/60'/0'/0/2");
    process.env.PROOFWORK_FEE_WALLET_BASE = proofworkWallet.address;

    // Platform fee wallet = funded hardhat account 1 (set per org).
    const platformWallet = HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, "m/44'/60'/0'/0/1");

    // Start API to seed demo bounty/org tables etc.
    const app = buildServer();
    await app.ready();

    // Configure demo org platform fee to 10% and its wallet address.
    await db
      .updateTable('orgs')
      .set({ platform_fee_bps: 1000, platform_fee_wallet_address: platformWallet.address })
      .where('id', '=', 'org_demo')
      .execute();

    // Create a worker and set payout address directly (we separately test signature endpoint).
    const w = await createWorker('w', { browser: true });
    const workerWallet = Wallet.createRandom();
    await db
      .updateTable('workers')
      .set({ payout_chain: 'base', payout_address: workerWallet.address, payout_address_verified_at: new Date(), payout_address_proof: {} })
      .where('id', '=', w.worker.id)
      .execute();

    const jobRow = await db.selectFrom('jobs').select(['id', 'bounty_id', 'fingerprint_class']).limit(1).executeTakeFirstOrThrow();

    const submissionId = nanoid(12);
    await addSubmission({
      id: submissionId,
      jobId: jobRow.id,
      workerId: w.worker.id,
      manifest: { manifestVersion: '1.0', jobId: jobRow.id, bountyId: jobRow.bounty_id, result: { expected: 'x', observed: 'y' } },
      artifactIndex: [],
      status: 'accepted',
      createdAt: Date.now(),
      payoutStatus: 'none',
    } as any);

    const payout = await addPayout(submissionId, w.worker.id, 1200);

    const { handlePayoutRequested, handlePayoutConfirmRequested } = await import('../workers/handlers.js');

    await handlePayoutRequested({ payoutId: payout.id });

    // Confirm (may need a short delay until receipt is available).
    for (let i = 0; i < 20; i++) {
      try {
        await handlePayoutConfirmRequested({ payoutId: payout.id });
        break;
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        if (msg.includes('tx_receipt_pending') || msg.includes('tx_not_enough_confirmations')) {
          await wait(250);
          continue;
        }
        throw err;
      }
    }

    const payoutRow = await db.selectFrom('payouts').selectAll().where('id', '=', payout.id).executeTakeFirstOrThrow();
    expect(payoutRow.status).toBe('paid');
    expect(payoutRow.amount_cents).toBe(1200);
    expect(payoutRow.net_amount_cents).toBe(1068);
    expect(payoutRow.platform_fee_cents).toBe(120);
    expect(payoutRow.platform_fee_wallet_address).toBe(platformWallet.address);
    expect((payoutRow as any).proofwork_fee_cents).toBe(12);
    expect((payoutRow as any).proofwork_fee_wallet_address).toBe(proofworkWallet.address);

    const transfers = await db.selectFrom('payout_transfers').selectAll().where('payout_id', '=', payout.id).orderBy('kind', 'asc').execute();
    expect(transfers.length).toBe(3);
    expect(transfers.map((t: any) => t.kind).sort()).toEqual(['net', 'platform_fee', 'proofwork_fee']);
    expect(transfers.every((t: any) => t.status === 'confirmed' || t.status === 'broadcast')).toBe(true);

    // Verify chain balances reflect net+fee (requires the tx to have succeeded).
    const provider = new JsonRpcProvider(HARDHAT_RPC);
    const usdcAbi = [
      'function balanceOf(address) view returns (uint256)',
    ];
    const usdc = new Contract(deployed.usdc, usdcAbi, provider);

    const workerBal = (await usdc.balanceOf(workerWallet.address)) as bigint;
    const platformBal = (await usdc.balanceOf(platformWallet.address)) as bigint;
    const proofworkBal = (await usdc.balanceOf(proofworkWallet.address)) as bigint;

    // 1068 cents => 10,680,000 base units.
    // 120 cents => 1,200,000 base units.
    // 12 cents => 120,000 base units.
    expect(workerBal).toBe(10_680_000n);
    expect(platformBal).toBe(1_200_000n);
    expect(proofworkBal).toBe(120_000n);
  });
});
