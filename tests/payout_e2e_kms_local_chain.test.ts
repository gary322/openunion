import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn, execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { HDNodeWallet, JsonRpcProvider, Contract, Wallet } from 'ethers';
import { nanoid } from 'nanoid';
import { buildServer } from '../src/server.js';
import { db } from '../src/db/client.js';
import { resetStore, addPayout, addSubmission, createWorker } from '../src/store.js';
import { KmsEvmSigner } from '../src/payments/crypto/kmsSigner.js';
import { encodeErc20ApproveCall, signAndBroadcastTx, getPendingNonce } from '../src/payments/crypto/baseUsdc.js';

const RUN = String(process.env.RUN_KMS_PAYOUT_TESTS ?? '').toLowerCase() === 'true' || process.env.RUN_KMS_PAYOUT_TESTS === '1';
const KMS_TEST_KEY_ID = String(process.env.KMS_TEST_KEY_ID ?? '').trim();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';
const HARDHAT_PORT = 40000 + Math.floor(Math.random() * 1000);
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

async function rpc(method: string, params: any[]) {
  const resp = await fetch(HARDHAT_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await resp.json();
  if (json?.error) throw new Error(`rpc_error:${json.error.code}:${json.error.message}`);
  return json.result;
}

let hardhatProc: ReturnType<typeof spawn> | undefined;
let deployed: { usdc: string; payoutSplitter: string; payerAddress: string } | undefined;
let kmsAddress: string | undefined;

const suite = describe.skipIf(!RUN || !KMS_TEST_KEY_ID);

beforeAll(async () => {
  if (!RUN || !KMS_TEST_KEY_ID) return;

  // Compile contracts once.
  execFileSync('npx', ['hardhat', 'compile', '--config', 'contracts/hardhat.config.ts'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  // Start Hardhat node.
  hardhatProc = spawn(
    'npx',
    ['hardhat', 'node', '--config', 'contracts/hardhat.config.ts', '--hostname', '127.0.0.1', '--port', String(HARDHAT_PORT)],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } }
  );
  hardhatProc.stdout?.on('data', () => {});
  hardhatProc.stderr?.on('data', () => {});
  await waitForRpc(HARDHAT_RPC);

  // Deploy MockUSDC + PayoutSplitter from funded hardhat account 0.
  const payer = HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, "m/44'/60'/0'/0/0");
  const out = execFileSync('npx', ['tsx', 'contracts/scripts/deploy-local.ts'], {
    cwd: repoRoot,
    env: { ...process.env, LOCAL_EVM_PRIVATE_KEY: payer.privateKey, LOCAL_EVM_RPC_URL: HARDHAT_RPC },
  }).toString('utf8');
  deployed = JSON.parse(out);

  // Create KMS signer and fund its address on the local chain.
  const kmsSigner = new KmsEvmSigner({ keyId: KMS_TEST_KEY_ID });
  kmsAddress = await kmsSigner.getAddress();

  // Give KMS address ETH for gas (100 ETH).
  await rpc('hardhat_setBalance', [kmsAddress, '0x56BC75E2D63100000']); // 100 * 1e18

  // Transfer some mock USDC to the KMS address so it can pay workers.
  const provider = new JsonRpcProvider(HARDHAT_RPC);
  const payerWallet = new Wallet(payer.privateKey, provider);
  const usdcAbi = [
    'function transfer(address to, uint256 amount) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
  ];
  const usdc = new Contract(deployed.usdc, usdcAbi, payerWallet);
  // 100 USDC (6 decimals).
  await (await usdc.transfer(kmsAddress, 100_000_000n)).wait();
});

afterAll(async () => {
  if (hardhatProc && !hardhatProc.killed) hardhatProc.kill('SIGTERM');
});

beforeEach(async () => {
  if (!RUN || !KMS_TEST_KEY_ID) return;
  await resetStore();
});

suite('Crypto payout E2E (KMS signer on local chain)', () => {
  it('approves and pays via splitter using KMS signer', async () => {
    if (!deployed || !kmsAddress) throw new Error('missing_deploy');

    // Configure payout worker to use KMS signer against the local RPC.
    process.env.PAYMENTS_PROVIDER = 'crypto_base_usdc';
    process.env.BASE_RPC_URL = HARDHAT_RPC;
    process.env.EVM_CHAIN_ID = '31337';
    process.env.BASE_USDC_ADDRESS = deployed.usdc;
    process.env.BASE_PAYOUT_SPLITTER_ADDRESS = deployed.payoutSplitter;
    process.env.BASE_CONFIRMATIONS_REQUIRED = '1';
    process.env.KMS_PAYOUT_KEY_ID = KMS_TEST_KEY_ID;

    // Proofwork fee 1%, paid to hardhat account 2.
    process.env.PROOFWORK_FEE_BPS = '100';
    const proofworkWallet = HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, "m/44'/60'/0'/0/2");
    process.env.PROOFWORK_FEE_WALLET_BASE = proofworkWallet.address;

    // Platform fee wallet = hardhat account 1.
    const platformWallet = HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, "m/44'/60'/0'/0/1");

    // Start API to seed demo tables.
    const app = buildServer();
    await app.ready();

    // Configure demo org platform fee to 10%.
    await db
      .updateTable('orgs')
      .set({ platform_fee_bps: 1000, platform_fee_wallet_address: platformWallet.address })
      .where('id', '=', 'org_demo')
      .execute();

    // Worker payout address.
    const w = await createWorker('w', { browser: true });
    const workerWallet = Wallet.createRandom();
    await db
      .updateTable('workers')
      .set({ payout_chain: 'base', payout_address: workerWallet.address, payout_address_verified_at: new Date(), payout_address_proof: {} })
      .where('id', '=', w.worker.id)
      .execute();

    // Approve the payout splitter from the KMS signer.
    const kmsSigner = new KmsEvmSigner({ keyId: KMS_TEST_KEY_ID });
    const nonce = await getPendingNonce(kmsAddress);
    const data = encodeErc20ApproveCall({ spender: deployed.payoutSplitter, amount: (1n << 256n) - 1n });
    await signAndBroadcastTx({
      signer: kmsSigner,
      chainId: 31337,
      nonce,
      gasLimit: 120000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      to: deployed.usdc,
      data,
    });

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
  });
});

