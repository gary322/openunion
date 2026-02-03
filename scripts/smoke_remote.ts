// Remote smoke test for a deployed Proofwork environment.
//
// This script:
// - creates a buyer API key (using the seeded demo user by default)
// - creates + publishes a bounty with a task_descriptor that the Universal Worker can satisfy
// - runs the Universal Worker once against the remote API
// - waits for the job to reach done/pass
//
// Usage:
//   BASE_URL=http://... npm run smoke:remote
//   npm run smoke:remote -- --base-url http://...
//
// Notes:
// - Do not print secrets. This script only prints non-sensitive IDs/URLs.
// - Prefer an existing buyer user via SMOKE_BUYER_EMAIL/SMOKE_BUYER_PASSWORD.
// - If those credentials do not work (e.g. demo seeding disabled), the script will fall back to
//   POST /api/org/register to create a new platform org + owner user + initial API key.
// - If publish fails with insufficient_funds, the script will attempt an admin top-up when
//   SMOKE_ADMIN_TOKEN is provided.

import { spawn } from 'node:child_process';

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

async function runUniversalWorkerOnce(input: { baseUrl: string; requireTaskType?: string }) {
  const env = {
    ...process.env,
    API_BASE_URL: input.baseUrl,
    ONCE: 'true',
    WAIT_FOR_DONE: 'true',
    // Force the worker to only consider jobs that include this tag so it won't consume seeded demo jobs.
    PREFER_CAPABILITY_TAG: 'llm_summarize',
    SUPPORTED_CAPABILITY_TAGS: 'browser,http,screenshot,llm_summarize',
    // Force the worker to only claim the task type created by this smoke run, so it cannot pick up
    // leftover jobs from prior runs that share capability tags.
    ...(input.requireTaskType ? { REQUIRE_TASK_TYPE: input.requireTaskType } : {}),
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
  const existing = (list.json?.origins ?? []).find((o: any) => String(o?.origin ?? '') === input.origin && String(o?.status ?? '') === 'verified');
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
  const checked = await fetchJson({ baseUrl: input.baseUrl, path: `/api/origins/${encodeURIComponent(originId)}/check`, method: 'POST', headers: authHeader });
  if (!checked.ok) throw new Error(`origin_check_failed:${checked.status}`);
  const status = String(checked.json?.origin?.status ?? '');
  if (status !== 'verified') throw new Error(`origin_not_verified:${status}`);
}

async function main() {
  const baseUrl = normalizeBaseUrl(argValue('--base-url') ?? process.env.BASE_URL ?? 'http://localhost:3000');
  const email = mustEnv('SMOKE_BUYER_EMAIL', 'buyer@example.com');
  const password = mustEnv('SMOKE_BUYER_PASSWORD', 'password');
  const smokeTaskType = `smoke_marketplace_results_${tsSuffix()}`;

  // Health
  const health = await fetchJson({ baseUrl, path: '/health' });
  if (!health.ok) throw new Error(`health_failed:${health.status}`);

  // Obtain buyer token (existing user or self-serve register).
  const auth = await ensureBuyerAuth({ baseUrl, email, password });
  const buyerToken = auth.buyerToken;

  const authHeader = { authorization: `Bearer ${buyerToken}` };

  // Ensure origin is verified for this org so bounty creation succeeds.
  const smokeOrigin = process.env.SMOKE_ORIGIN ?? 'https://example.com';
  await ensureVerifiedOrigin({ baseUrl, buyerToken, origin: smokeOrigin });

  // Create a bounty with a descriptor that our Universal Worker can deterministically satisfy.
  const bountyTitle = `Smoke bounty ${new Date().toISOString()}`;
  const bountyResp = await fetchJson({
    baseUrl,
    path: '/api/bounties',
    method: 'POST',
    headers: authHeader,
    body: {
      title: bountyTitle,
      description: 'Smoke test bounty for task_descriptor + universal worker.',
      allowedOrigins: [smokeOrigin],
      requiredProofs: 1,
      fingerprintClassesRequired: ['desktop_us'],
      payoutCents: 1500,
      taskDescriptor: {
        schema_version: 'v1',
        type: smokeTaskType,
        capability_tags: ['browser', 'screenshot', 'http', 'llm_summarize'],
        input_spec: { url: 'https://example.com', query: 'example' },
        output_spec: {
          required_artifacts: [
            { kind: 'screenshot', label: 'universal_screenshot' },
            { kind: 'other', label_prefix: 'results' },
            { kind: 'log', label: 'report_summary' },
          ],
        },
        freshness_sla_sec: 3600,
      },
    },
  });
  if (!bountyResp.ok) throw new Error(`bounty_create_failed:${bountyResp.status}:${bountyResp.json?.error?.code ?? ''}`);
  const bountyId = String(bountyResp.json?.id ?? '');
  if (!bountyId) throw new Error('bounty_create_missing_id');

  // Publish bounty (creates open jobs).
  let pub = await fetchJson({ baseUrl, path: `/api/bounties/${encodeURIComponent(bountyId)}/publish`, method: 'POST', headers: authHeader });
  if (!pub.ok) {
    const code = String(pub.json?.error?.code ?? '');
    if (pub.status === 409 && code === 'insufficient_funds') {
      const adminToken = String(process.env.SMOKE_ADMIN_TOKEN ?? '').trim();
      let orgId = auth.orgId;
      if (!orgId) {
        const acct = await fetchJson({ baseUrl, path: '/api/billing/account', headers: authHeader });
        orgId = String(acct.json?.account?.org_id ?? acct.json?.account?.orgId ?? '') || undefined;
      }
      if (!adminToken || !orgId) {
        throw new Error(`bounty_publish_failed_insufficient_funds:missing_admin_or_org_id`);
      }
      const amountCents = Number(process.env.SMOKE_TOPUP_CENTS ?? 10_000);
      const top = await fetchJson({
        baseUrl,
        path: `/api/admin/billing/orgs/${encodeURIComponent(orgId)}/topup`,
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}` },
        body: { amountCents },
      });
      if (!top.ok) throw new Error(`admin_topup_failed:${top.status}`);
      pub = await fetchJson({ baseUrl, path: `/api/bounties/${encodeURIComponent(bountyId)}/publish`, method: 'POST', headers: authHeader });
    }
  }
  if (!pub.ok) throw new Error(`bounty_publish_failed:${pub.status}:${pub.json?.error?.code ?? ''}`);

  // Ensure job exists.
  const jobs0 = await fetchJson({ baseUrl, path: `/api/bounties/${encodeURIComponent(bountyId)}/jobs`, headers: authHeader });
  if (!jobs0.ok) throw new Error(`bounty_jobs_failed:${jobs0.status}`);
  const jobId = String(jobs0.json?.jobs?.[0]?.id ?? '');
  if (!jobId) throw new Error('missing_job_id_after_publish');

  console.log(`[smoke] base_url=${baseUrl}`);
  console.log(`[smoke] bounty_id=${bountyId}`);
  console.log(`[smoke] job_id=${jobId}`);

  // Run a real Universal Worker against this environment (claims job + uploads artifacts + submits).
  await runUniversalWorkerOnce({ baseUrl, requireTaskType: smokeTaskType });

  // Poll until job is done/pass (buyer view).
  const deadline = Date.now() + 5 * 60_000;
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

  // Close bounty to avoid accumulating open work.
  await fetchJson({ baseUrl, path: `/api/bounties/${encodeURIComponent(bountyId)}/close`, method: 'POST', headers: authHeader });

  console.log('[smoke] OK');
}

main().catch((err) => {
  console.error('[smoke] FAILED', err);
  process.exitCode = 1;
});
