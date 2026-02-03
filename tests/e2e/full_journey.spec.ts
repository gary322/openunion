import { test, expect } from '@playwright/test';
import http from 'http';
import { spawn, execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';
import { Contract, ContractFactory, HDNodeWallet, JsonRpcProvider, Wallet, getAddress } from 'ethers';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForRpc(url: string, timeoutMs = 30_000) {
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
  throw new Error('rpc_not_ready');
}

async function loadHardhatArtifact(rel: string) {
  const p = path.resolve(repoRoot, 'contracts', 'artifacts', rel);
  const txt = await readFile(p, 'utf8');
  const json = JSON.parse(txt) as any;
  if (!json?.abi || !json?.bytecode) throw new Error(`bad_artifact:${rel}`);
  return json;
}

test('buyer → bounty → worker → upload → verify (gateway) → payout (local chain)', async ({ page, request }) => {
  test.setTimeout(180_000);

  const baseURL = String(test.info().project.use.baseURL ?? 'http://localhost:3111').replace(/\/$/, '');

  let targetServer: http.Server | undefined;
  let originVerifyToken = '';
  let gateway: any | undefined;
  let hardhat: ReturnType<typeof spawn> | undefined;
  let pool: pg.Pool | undefined;

  try {
    // Start deterministic target page server (so verifier harness has something to visit).
    targetServer = http.createServer((req, res) => {
      if (req.url === '/.well-known/proofwork-verify.txt') {
        if (!originVerifyToken) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('missing');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(originVerifyToken);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>E2E</title></head><body><h1>OK</h1><script>console.log("e2e_target_loaded")</script></body></html>`
      );
    });
    await new Promise<void>((resolve) => targetServer!.listen(0, '127.0.0.1', () => resolve()));
    const targetPort = (targetServer.address() as any).port as number;
    const targetOrigin = `http://127.0.0.1:${targetPort}`;

    // Start verifier gateway in-process (it will upload evidence artifacts back to the API).
    process.env.API_BASE_URL = baseURL;
    process.env.PUBLIC_BASE_URL = baseURL;
    process.env.VERIFIER_TOKEN = process.env.VERIFIER_TOKEN ?? 'pw_vf_internal';

    const { buildVerifierGateway } = await import('../../services/verifier-gateway/server.js');
    gateway = buildVerifierGateway();
    const gatewayPort = 41000 + Math.floor(Math.random() * 1000);
    await gateway.listen({ port: gatewayPort, host: '127.0.0.1' });
    process.env.VERIFIER_GATEWAY_URL = `http://127.0.0.1:${gatewayPort}/run`;

    // Start Hardhat node + deploy MockUSDC + PayoutSplitter for deterministic payouts.
    const hardhatPort = 42000 + Math.floor(Math.random() * 1000);
    const hardhatRpc = `http://127.0.0.1:${hardhatPort}`;

    // Compile if needed (CI checkout won't have artifacts).
    execFileSync('npx', ['hardhat', 'compile', '--config', 'contracts/hardhat.config.ts'], { cwd: repoRoot, stdio: 'inherit' });

    hardhat = spawn(
      'npx',
      ['hardhat', 'node', '--config', 'contracts/hardhat.config.ts', '--hostname', '127.0.0.1', '--port', String(hardhatPort)],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    await waitForRpc(hardhatRpc);

    const provider = new JsonRpcProvider(hardhatRpc);
    const payer = HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, "m/44'/60'/0'/0/0").connect(provider);
    const platformWallet = HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, "m/44'/60'/0'/0/1");
    const proofworkWallet = HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, "m/44'/60'/0'/0/2");

    const usdcArtifact = await loadHardhatArtifact('contracts/MockUSDC.sol/MockUSDC.json');
    const splitterArtifact = await loadHardhatArtifact('contracts/PayoutSplitter.sol/PayoutSplitter.json');

    const usdcFactory = new ContractFactory(usdcArtifact.abi, usdcArtifact.bytecode, payer);
    const splitterFactory = new ContractFactory(splitterArtifact.abi, splitterArtifact.bytecode, payer);

    const payerAddr = getAddress(await payer.getAddress());
    let nonce = await provider.getTransactionCount(payerAddr, 'pending');

    const usdc = await usdcFactory.deploy({ nonce });
    await usdc.waitForDeployment();
    nonce++;

    const splitter = await splitterFactory.deploy({ nonce });
    await splitter.waitForDeployment();
    nonce++;

    const mintAmount = 1_000_000_000n; // 1000 USDC (6 decimals)
    const approveAmount = 10_000_000_000n;
    await (await usdc.mint(payerAddr, mintAmount, { nonce })).wait();
    nonce++;
    await (await usdc.approve(await splitter.getAddress(), approveAmount, { nonce })).wait();

    // Configure payout handler env (crypto_evm_local).
    process.env.PAYMENTS_PROVIDER = 'crypto_evm_local';
    process.env.LOCAL_EVM_PRIVATE_KEY = payer.privateKey;
    process.env.LOCAL_EVM_RPC_URL = hardhatRpc;
    process.env.BASE_RPC_URL = hardhatRpc;
    process.env.EVM_CHAIN_ID = '31337';
    process.env.BASE_USDC_ADDRESS = await usdc.getAddress();
    process.env.BASE_PAYOUT_SPLITTER_ADDRESS = await splitter.getAddress();
    process.env.BASE_CONFIRMATIONS_REQUIRED = '1';
    process.env.PROOFWORK_FEE_BPS = '100';
    process.env.PROOFWORK_FEE_WALLET_BASE = proofworkWallet.address;

    // --- Buyer portal: login → create key → add+verify origin → create+publish bounty.
    await page.goto('/buyer/index.html');
    await page.click('#btnLogin');
    await expect(page.locator('#loginStatus')).toContainText('ok');

    // Configure org platform fee: 10% to platformWallet.
    await page.fill('#pfBps', '1000');
    await page.fill('#pfWallet', platformWallet.address);
    await page.click('#btnSetPlatformFee');
    await expect(page.locator('#pfStatus')).toContainText('saved');

    await page.click('#btnCreateKey');
    await expect(page.locator('#keyStatus')).toContainText('token created');

    await page.fill('#originUrl', targetOrigin);
    await page.fill('#originMethod', 'http_file');
    const addOriginRespPromise = page.waitForResponse(
      (r) => r.url().includes('/api/origins') && r.request().method() === 'POST'
    );
    await page.click('#btnAddOrigin');
    const addOriginResp = await addOriginRespPromise;
    expect(addOriginResp.ok()).toBeTruthy();
    const addOriginJson = (await addOriginResp.json()) as any;
    originVerifyToken = String(addOriginJson?.origin?.token ?? '');
    expect(originVerifyToken).toMatch(/^pw_verify_/);
    await expect(page.locator('#originStatus')).toContainText('added origin');

    // Auto-verifies pending origins.
    await page.click('#btnCheckOrigin');
    await expect(page.locator('#originStatus')).toContainText('status=verified');

    // Create a bounty with a payout higher than the seeded demo bounty so the worker selects it.
    await page.fill('#bTitle', `E2E bounty ${Date.now()}`);
    await page.fill('#bDesc', 'E2E full journey');
    await page.fill('#bOrigins', targetOrigin);
    await page.fill('#bPayout', '2000');
    await page.fill('#bFps', 'desktop_us');
    await page.click('#btnCreateBounty');
    await expect(page.locator('#bountyStatus')).toContainText('created bounty');

    // Publish the bounty.
    await page.click('#btnPublish');
    await expect(page.locator('#bountyStatus')).toContainText('published');

    // --- Worker portal: register → next → claim → upload → submit.
    await page.goto('/worker/index.html');
    await page.click('#btnRegister');
    await expect(page.locator('#authStatus')).toContainText('Registered workerId');

    const workerToken = await page.locator('#token').inputValue();
    expect(workerToken).toMatch(/^pw_wk_/);

    // Register payout address (signed proof).
    const me = await request.get('/api/worker/me', { headers: { Authorization: `Bearer ${workerToken}` } });
    expect(me.ok()).toBeTruthy();
    const meJson = await me.json();
    const workerId = String(meJson.workerId);

    const workerWallet = Wallet.createRandom();
    const normalized = getAddress(workerWallet.address);
    const message = `Proofwork payout address verification\nworkerId=${workerId}\nchain=base\naddress=${normalized}`;
    const signature = await workerWallet.signMessage(message);
    const setAddr = await request.post('/api/worker/payout-address', {
      headers: { Authorization: `Bearer ${workerToken}` },
      data: { chain: 'base', address: normalized, signature },
    });
    expect(setAddr.ok()).toBeTruthy();

    await page.click('#btnNext');
    await expect(page.locator('#jobStatus')).toContainText('state=claimable');

    await page.click('#btnClaim');
    await expect(page.locator('#jobStatus')).toContainText('claimed leaseNonce=');

    // Upload a minimal PNG (scanner checks signature only).
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    await page.setInputFiles('#file', { name: 'shot.png', mimeType: 'image/png', buffer: png });
    await page.selectOption('#kind', 'screenshot');
    await page.fill('#label', 'repro');

    await page.click('#btnUpload');
    await expect(page.locator('#uploadStatus')).toContainText('uploaded artifactId=');

    await page.fill('#expected', 'Expected behavior here');
    await page.fill('#observed', 'Observed behavior here');

    const submitRespPromise = page.waitForResponse(
      (r) => r.url().includes('/api/jobs/') && r.url().endsWith('/submit') && r.request().method() === 'POST'
    );
    await page.click('#btnSubmit');
    const submitResp = await submitRespPromise;
    expect(submitResp.ok()).toBeTruthy();
    const submitJson = (await submitResp.json()) as any;
    const submissionId = String(submitJson?.data?.submission?.id ?? '');
    const jobId = String(submitJson?.data?.jobStatus?.id ?? submitJson?.data?.jobStatus?.jobId ?? '');
    expect(submissionId).toBeTruthy();
    expect(jobId).toBeTruthy();

    // --- Drive verification + payout through the actual worker handlers (no background loops).
    process.env.API_BASE_URL = baseURL;
    process.env.VERIFIER_TOKEN = process.env.VERIFIER_TOKEN ?? 'pw_vf_internal';

    const { handleVerificationRequested, handlePayoutRequested, handlePayoutConfirmRequested } = await import('../../workers/handlers.js');

    await handleVerificationRequested({ submissionId, attemptNo: 1 });

    // Job should be done with pass.
    let final: any;
    for (let i = 0; i < 40; i++) {
      const st = await request.get(`/api/jobs/${encodeURIComponent(jobId)}`, { headers: { Authorization: `Bearer ${workerToken}` } });
      final = (await st.json()) as any;
      if (final?.status === 'done' && final?.finalVerdict === 'pass') break;
      await wait(250);
    }
    expect(final?.status).toBe('done');
    expect(final?.finalVerdict).toBe('pass');

    // Find the payout for this submission.
    const { Pool } = pg;
    const dbUrl = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/proofwork';
    pool = new Pool({ connectionString: dbUrl });
    const payoutRow = await pool
      .query<{ id: string }>('SELECT id FROM payouts WHERE submission_id = $1 ORDER BY created_at DESC LIMIT 1', [submissionId])
      .then((r) => r.rows[0]);
    expect(payoutRow?.id).toBeTruthy();
    const payoutId = payoutRow.id;

    await handlePayoutRequested({ payoutId });

    for (let i = 0; i < 40; i++) {
      try {
        await handlePayoutConfirmRequested({ payoutId });
      } catch {
        // ignore transient confirmation errors
      }
      const row = await pool
        .query<{ status: string }>('SELECT status FROM payouts WHERE id = $1', [payoutId])
        .then((r) => r.rows[0]);
      if (row?.status === 'paid') break;
      await wait(250);
    }

    const paid = await pool
      .query<{ status: string; net_amount_cents: number | null; platform_fee_cents: number | null; proofwork_fee_cents: number | null }>(
        'SELECT status, net_amount_cents, platform_fee_cents, proofwork_fee_cents FROM payouts WHERE id = $1',
        [payoutId]
      )
      .then((r) => r.rows[0]);
    expect(paid.status).toBe('paid');
    // Platform fee is taken from gross first; Proofwork fee is taken from the worker portion.
    // gross=2000, platform=200 => worker gross=1800, proofwork=18 => net=1782.
    expect(paid.net_amount_cents).toBe(1782);
    expect(paid.platform_fee_cents).toBe(200);
    expect(paid.proofwork_fee_cents).toBe(18);

    // On-chain assertions: net to worker, fees to platform + proofwork.
    const usdcRead = new Contract(await usdc.getAddress(), ['function balanceOf(address) view returns (uint256)'], provider);
    const workerBal = (await usdcRead.balanceOf(workerWallet.address)) as bigint;
    const platformBal = (await usdcRead.balanceOf(platformWallet.address)) as bigint;
    const proofworkBal = (await usdcRead.balanceOf(proofworkWallet.address)) as bigint;
    expect(workerBal).toBe(17_820_000n);
    expect(platformBal).toBe(2_000_000n);
    expect(proofworkBal).toBe(180_000n);
  } finally {
    try {
      await pool?.end();
    } catch {
      // ignore
    }
    try {
      await gateway?.close();
    } catch {
      // ignore
    }
    try {
      await new Promise<void>((resolve) => targetServer?.close(() => resolve()));
    } catch {
      // ignore
    }
    try {
      hardhat?.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
});
