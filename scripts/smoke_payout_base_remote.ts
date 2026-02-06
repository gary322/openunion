// Remote payout smoke test against a deployed Proofwork environment configured for Base USDC payouts.
//
// This script performs a full happy-path journey:
// - creates/obtains a buyer API key
// - creates + publishes a bounty with a small payout amount
// - registers a worker + sets a Base payout address (message-signature flow)
// - runs the Universal Worker once (claims + submits)
// - waits for job done/pass
// - waits for payout paid and confirms USDC balances changed on Base mainnet
//
// Usage:
//   BASE_URL=http://... SMOKE_ADMIN_TOKEN=... tsx scripts/smoke_payout_base_remote.ts
//
// Notes:
// - This spends real USDC on Base when PAYMENTS_PROVIDER=crypto_base_usdc is enabled server-side.
// - Do not print secrets. This script only prints non-sensitive IDs/URLs/tx hashes/addresses.

import { spawn } from 'node:child_process';
import { ethers } from 'ethers';

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function mustEnv(name: string, fallback?: string): string {
  const v = (process.env[name] ?? fallback ?? '').toString().trim();
  if (!v) throw new Error(`missing_${name}`);
  return v;
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/$/, '');
}

function tsSuffix() {
  return new Date().toISOString().replace(/[:.]/g, '');
}

async function fetchJson(input: {
  baseUrl: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: any;
}): Promise<{ status: number; ok: boolean; headers: Headers; json: any; text: string }> {
  const url = `${input.baseUrl}${input.path}`;
  const resp = await fetch(url, {
    method: input.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(input.headers ?? {}) },
    body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
  });
  const text = await resp.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: resp.status, ok: resp.ok, headers: resp.headers, json, text };
}

async function runUniversalWorkerOnce(input: {
  baseUrl: string;
  workerToken: string;
  requireTaskType: string;
}) {
  const env = {
    ...process.env,
    API_BASE_URL: input.baseUrl,
    WORKER_TOKEN: input.workerToken,
    ONCE: 'true',
    WAIT_FOR_DONE: 'true',
    // Keep this minimal to avoid long Playwright runs; the smoke job is http+llm only.
    // Include `ffmpeg` as an isolation tag so other workers (that don't opt into ffmpeg) won't
    // claim the smoke job. We intentionally do NOT provide input_spec.vod_url so no ffmpeg binary
    // is required for this test.
    SUPPORTED_CAPABILITY_TAGS: 'ffmpeg,http,llm_summarize',
    PREFER_CAPABILITY_TAG: 'llm_summarize',
    REQUIRE_TASK_TYPE: input.requireTaskType,
    UNIVERSAL_WORKER_CANARY_PERCENT: '100',
  };

  await new Promise<void>((resolve, reject) => {
    const child = spawn('npm', ['run', '-s', 'worker:universal'], {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => {
      const s = String(d);
      stderr += s;
      process.stderr.write(d);
    });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if ((code ?? 1) !== 0) return reject(new Error(`universal_worker_failed:${code}\n${stderr}`));
      resolve();
    });
  });
}

async function ensureBuyerAuth(input: {
  baseUrl: string;
  email: string;
  password: string;
}): Promise<{ buyerToken: string; orgId?: string; email: string; password: string }> {
  // Try existing login first.
  const apiKeyResp = await fetchJson({
    baseUrl: input.baseUrl,
    path: '/api/org/api-keys',
    method: 'POST',
    body: { email: input.email, password: input.password, name: `smoke-${tsSuffix()}` },
  });
  if (apiKeyResp.ok) {
    const buyerToken = String(apiKeyResp.json?.token ?? '');
    if (!buyerToken) throw new Error('api_key_missing_token');
    return { buyerToken, email: input.email, password: input.password };
  }

  // Fall back to self-serve registration.
  let email = input.email;
  let password = input.password;
  if (email === 'buyer@example.com' && !process.env.SMOKE_BUYER_EMAIL) {
    email = `smoke+${tsSuffix()}@example.com`;
    password = `pw_${tsSuffix()}_demo`;
  }

  const reg = await fetchJson({
    baseUrl: input.baseUrl,
    path: '/api/org/register',
    method: 'POST',
    body: {
      orgName: process.env.SMOKE_ORG_NAME ?? `Smoke Platform ${tsSuffix()}`,
      email,
      password,
      apiKeyName: process.env.SMOKE_API_KEY_NAME ?? 'default',
    },
  });

  if (!reg.ok) {
    // If the email already exists, retry api-key creation (assumes caller provided the correct password).
    const code = String(reg.json?.error?.message ?? '');
    if (reg.status === 409 && code.includes('email_already_registered')) {
      const retry = await fetchJson({
        baseUrl: input.baseUrl,
        path: '/api/org/api-keys',
        method: 'POST',
        body: { email, password, name: `smoke-${tsSuffix()}` },
      });
      if (!retry.ok) throw new Error(`api_key_create_failed_after_conflict:${retry.status}`);
      const buyerToken = String(retry.json?.token ?? '');
      if (!buyerToken) throw new Error('api_key_missing_token');
      return { buyerToken, email, password };
    }
    throw new Error(`org_register_failed:${reg.status}:${reg.json?.error?.message ?? ''}`);
  }

  const buyerToken = String(reg.json?.token ?? '');
  const orgId = String(reg.json?.orgId ?? '');
  if (!buyerToken) throw new Error('org_register_missing_token');
  return { buyerToken, orgId: orgId || undefined, email, password };
}

async function ensureVerifiedOrigin(input: { baseUrl: string; buyerToken: string; origin: string }) {
  const authHeader = { authorization: `Bearer ${input.buyerToken}` };
  const list = await fetchJson({ baseUrl: input.baseUrl, path: '/api/origins', headers: authHeader });
  if (!list.ok) throw new Error(`origins_list_failed:${list.status}`);
  const existing = (list.json?.origins ?? []).find(
    (o: any) => String(o?.origin ?? '') === input.origin && String(o?.status ?? '') === 'verified'
  );
  if (existing) return;

  const created = await fetchJson({
    baseUrl: input.baseUrl,
    path: '/api/origins',
    method: 'POST',
    headers: authHeader,
    body: { origin: input.origin, method: 'dns_txt' },
  });
  if (!created.ok) throw new Error(`origin_create_failed:${created.status}:${created.json?.error?.code ?? ''}`);
  const originId = String(created.json?.origin?.id ?? '');
  if (!originId) throw new Error('origin_create_missing_id');

  // In this repo's current implementation, check auto-verifies pending origins. This keeps smoke tests deterministic.
  const checked = await fetchJson({
    baseUrl: input.baseUrl,
    path: `/api/origins/${encodeURIComponent(originId)}/check`,
    method: 'POST',
    headers: authHeader,
  });
  if (!checked.ok) throw new Error(`origin_check_failed:${checked.status}`);
  const status = String(checked.json?.origin?.status ?? '');
  if (status !== 'verified') throw new Error(`origin_not_verified:${status}`);
}

async function main() {
  const baseUrl = normalizeBaseUrl(argValue('--base-url') ?? process.env.BASE_URL ?? 'http://localhost:3000');
  const email = mustEnv('SMOKE_BUYER_EMAIL', 'buyer@example.com');
  const password = mustEnv('SMOKE_BUYER_PASSWORD', 'password');

  const payoutCentsRaw = Number(process.env.SMOKE_PAYOUT_CENTS ?? 100);
  const payoutCents = Number.isFinite(payoutCentsRaw) ? Math.max(100, Math.min(5_000, Math.floor(payoutCentsRaw))) : 100;

  const smokeTaskType = `smoke_payout_${tsSuffix()}`;
  const smokeOrigin = process.env.SMOKE_ORIGIN ?? 'https://example.com';
  let bountyId: string | null = null;

  // Health
  const health = await fetchJson({ baseUrl, path: '/health' });
  if (!health.ok) throw new Error(`health_failed:${health.status}`);

  // On-chain balances (Base mainnet)
  const baseRpcUrl = String(process.env.BASE_RPC_URL ?? 'https://mainnet.base.org').trim();
  const usdcAddr = String(process.env.BASE_USDC_ADDRESS ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913').trim();
  const feeWallet = String(process.env.PROOFWORK_FEE_WALLET_BASE ?? '0xC9862D6326E93b818d7C735Dc8af6eBddD066bDF').trim();

  const provider = new ethers.JsonRpcProvider(baseRpcUrl);
  const usdc = new ethers.Contract(usdcAddr, ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'], provider);
  const decimals = Number(await usdc.decimals());

  // Worker payout address (local ephemeral wallet)
  const wallet = ethers.Wallet.createRandom();
  const payoutAddress = await wallet.getAddress();

  const beforeWorker = (await usdc.balanceOf(payoutAddress)) as bigint;
  const beforeFee = (await usdc.balanceOf(feeWallet)) as bigint;

  // Obtain buyer token (existing user or self-serve register).
  const auth = await ensureBuyerAuth({ baseUrl, email, password });
  const buyerToken = auth.buyerToken;
  const authHeader = { authorization: `Bearer ${buyerToken}` };

  // Ensure origin verified for bounty creation.
  await ensureVerifiedOrigin({ baseUrl, buyerToken, origin: smokeOrigin });

  try {
    // Register smoke task type in the app registry (required for taskDescriptor.type).
    const appReg = await fetchJson({
      baseUrl,
      path: '/api/org/apps',
      method: 'POST',
      headers: authHeader,
      body: {
        slug: `smoke-${Date.now()}`,
        taskType: smokeTaskType,
        name: 'Smoke Payout App',
        description: 'auto-created by smoke_payout_base_remote.ts',
        public: false,
        dashboardUrl: '/apps/',
      },
    });
    if (!appReg.ok && appReg.status !== 409) {
      throw new Error(`app_register_failed:${appReg.status}:${appReg.json?.error?.code ?? ''}`);
    }

    // Register a dedicated worker token so we can configure payout address up front.
    const regWorker = await fetchJson({
      baseUrl,
      path: '/api/workers/register',
      method: 'POST',
      body: { displayName: 'smoke', capabilities: { http: true, llm_summarize: true } },
    });
    if (!regWorker.ok) throw new Error(`worker_register_failed:${regWorker.status}`);
    const workerToken = String(regWorker.json?.token ?? '');
    if (!workerToken) throw new Error('worker_register_missing_token');

    // Configure payout address for this worker (message -> sign -> set).
    const msg = await fetchJson({
      baseUrl,
      path: '/api/worker/payout-address/message',
      method: 'POST',
      headers: { authorization: `Bearer ${workerToken}` },
      body: { chain: 'base', address: payoutAddress },
    });
    if (!msg.ok) throw new Error(`payout_message_failed:${msg.status}`);
    const message = String(msg.json?.message ?? '');
    if (!message) throw new Error('payout_message_missing');
    const signature = await wallet.signMessage(message);

    const setAddr = await fetchJson({
      baseUrl,
      path: '/api/worker/payout-address',
      method: 'POST',
      headers: { authorization: `Bearer ${workerToken}` },
      body: { chain: 'base', address: payoutAddress, signature },
    });
    if (!setAddr.ok) throw new Error(`payout_set_failed:${setAddr.status}`);

    // Create bounty.
    const bountyResp = await fetchJson({
      baseUrl,
      path: '/api/bounties',
      method: 'POST',
      headers: authHeader,
      body: {
        title: `Smoke payout bounty ${new Date().toISOString()}`,
        description: 'Smoke test bounty for Base USDC payouts.',
        allowedOrigins: [smokeOrigin],
        // Ensure payouts execute immediately (no dispute hold) so this smoke is deterministic.
        disputeWindowSec: 0,
        requiredProofs: 1,
        fingerprintClassesRequired: ['desktop_us'],
        payoutCents,
        taskDescriptor: {
          schema_version: 'v1',
          type: smokeTaskType,
          // Isolation tag: most workers will not opt into ffmpeg jobs.
          // This smoke does not provide a vod_url, so ffmpeg is never executed.
          capability_tags: ['ffmpeg', 'http', 'llm_summarize'],
          input_spec: { url: 'https://example.com', query: 'example' },
          output_spec: {
            http_response: true,
            required_artifacts: [{ kind: 'log', label: 'report_summary' }],
          },
          freshness_sla_sec: 3600,
        },
      },
    });
    if (!bountyResp.ok) throw new Error(`bounty_create_failed:${bountyResp.status}:${bountyResp.json?.error?.code ?? ''}`);
    bountyId = String(bountyResp.json?.id ?? '');
    if (!bountyId) throw new Error('bounty_create_missing_id');

    // Publish bounty (creates open jobs). If insufficient funds, attempt admin top-up.
    let pub = await fetchJson({
      baseUrl,
      path: `/api/bounties/${encodeURIComponent(bountyId)}/publish`,
      method: 'POST',
      headers: authHeader,
    });
    if (!pub.ok) {
      const code = String(pub.json?.error?.code ?? '');
      if (pub.status === 409 && code === 'insufficient_funds') {
        const adminToken = String(process.env.SMOKE_ADMIN_TOKEN ?? '').trim();
        let orgId = auth.orgId;
        if (!orgId) {
          const acct = await fetchJson({ baseUrl, path: '/api/billing/account', headers: authHeader });
          orgId = String(acct.json?.account?.org_id ?? acct.json?.account?.orgId ?? '') || undefined;
        }
        if (!adminToken || !orgId) throw new Error('bounty_publish_failed_insufficient_funds:missing_admin_or_org_id');
        const amountCents = Number(process.env.SMOKE_TOPUP_CENTS ?? 10_000);
        const top = await fetchJson({
          baseUrl,
          path: `/api/admin/billing/orgs/${encodeURIComponent(orgId)}/topup`,
          method: 'POST',
          headers: { authorization: `Bearer ${adminToken}` },
          body: { amountCents },
        });
        if (!top.ok) throw new Error(`admin_topup_failed:${top.status}`);
        pub = await fetchJson({
          baseUrl,
          path: `/api/bounties/${encodeURIComponent(bountyId)}/publish`,
          method: 'POST',
          headers: authHeader,
        });
      }
    }
    if (!pub.ok) throw new Error(`bounty_publish_failed:${pub.status}:${pub.json?.error?.code ?? ''}`);

    // Ensure job exists (used for buyer-side progress checks).
    const jobs0 = await fetchJson({ baseUrl, path: `/api/bounties/${encodeURIComponent(bountyId)}/jobs`, headers: authHeader });
    if (!jobs0.ok) throw new Error(`bounty_jobs_failed:${jobs0.status}`);
    const jobId = String(jobs0.json?.jobs?.[0]?.id ?? '');
    if (!jobId) throw new Error('missing_job_id_after_publish');

    console.log(`[smoke_payout] base_url=${baseUrl}`);
    console.log(`[smoke_payout] bounty_id=${bountyId}`);
    console.log(`[smoke_payout] job_id=${jobId}`);
    console.log(`[smoke_payout] payout_cents=${payoutCents}`);
    console.log(`[smoke_payout] payout_address=${payoutAddress}`);

    // Run a real Universal Worker against this environment (claims job + submits).
    await runUniversalWorkerOnce({ baseUrl, workerToken, requireTaskType: smokeTaskType });

    // Poll until job is done/pass (buyer view).
    const deadline = Date.now() + 8 * 60_000;
    for (;;) {
      const jobs = await fetchJson({ baseUrl, path: `/api/bounties/${encodeURIComponent(bountyId)}/jobs`, headers: authHeader });
      if (!jobs.ok) throw new Error(`bounty_jobs_poll_failed:${jobs.status}`);
      const row = (jobs.json?.jobs ?? []).find((j: any) => String(j?.id ?? '') === jobId);
      const status = String(row?.status ?? '');
      const verdict = String(row?.finalVerdict ?? '');
      if (status === 'done' && verdict === 'pass') break;
      if (Date.now() > deadline) throw new Error(`timeout_waiting_for_done:status=${status}:verdict=${verdict}`);
      await sleep(2000);
    }

    // Wait for payout to be created and paid.
    let payout: any = null;
    const payoutDeadline = Date.now() + 10 * 60_000;
    for (;;) {
      const res = await fetchJson({
        baseUrl,
        path: `/api/worker/payouts?page=1&limit=50`,
        headers: { authorization: `Bearer ${workerToken}` },
      });
      if (!res.ok) throw new Error(`worker_payouts_failed:${res.status}`);
      const payouts: any[] = Array.isArray(res.json?.payouts) ? res.json.payouts : [];
      payout = payouts.find((p) => String(p?.jobId ?? '') === jobId) ?? null;
      if (payout && String(payout.status ?? '') === 'paid' && String(payout.providerRef ?? '').startsWith('0x')) break;
      if (Date.now() > payoutDeadline) throw new Error(`timeout_waiting_for_payout:${payout ? JSON.stringify(payout) : 'missing'}`);
      await sleep(3000);
    }

    const txHash = String(payout.providerRef);
    console.log(`[smoke_payout] payout_id=${String(payout.id ?? '')} status=paid tx=${txHash}`);

    // Confirm tx mined.
    const receipt = await provider.waitForTransaction(txHash, 1, 120_000);
    if (!receipt || receipt.status !== 1) throw new Error('payout_tx_not_mined');

    // Confirm balances increased.
    const afterWorker = (await usdc.balanceOf(payoutAddress)) as bigint;
    const afterFee = (await usdc.balanceOf(feeWallet)) as bigint;
    const workerDelta = afterWorker - beforeWorker;
    const feeDelta = afterFee - beforeFee;

    console.log(`[smoke_payout] usdc_worker_delta=${ethers.formatUnits(workerDelta, decimals)}`);
    console.log(`[smoke_payout] usdc_fee_delta=${ethers.formatUnits(feeDelta, decimals)}`);

    if (workerDelta <= 0n) throw new Error('worker_usdc_not_increased');
    if (feeDelta <= 0n) throw new Error('fee_usdc_not_increased');

    console.log('[smoke_payout] OK');
  } finally {
    if (bountyId) {
      // Always try to close the bounty so the smoke does not leave open, claimable jobs behind.
      await fetchJson({ baseUrl, path: `/api/bounties/${encodeURIComponent(bountyId)}/close`, method: 'POST', headers: authHeader }).catch(
        () => undefined
      );
    }
  }
}

main().catch((err) => {
  console.error('[smoke_payout] FAILED', err);
  process.exitCode = 1;
});
