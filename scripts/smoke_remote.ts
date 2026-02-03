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
// - Assumes the environment has a seeded buyer user (buyer@example.com/password) OR that you
//   override SMOKE_BUYER_EMAIL/SMOKE_BUYER_PASSWORD.

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

async function main() {
  const baseUrl = normalizeBaseUrl(argValue('--base-url') ?? process.env.BASE_URL ?? 'http://localhost:3000');
  const email = mustEnv('SMOKE_BUYER_EMAIL', 'buyer@example.com');
  const password = mustEnv('SMOKE_BUYER_PASSWORD', 'password');
  const smokeTaskType = `smoke_marketplace_results_${new Date().toISOString().replace(/[:.]/g, '')}`;

  // Health
  const health = await fetchJson({ baseUrl, path: '/health' });
  if (!health.ok) throw new Error(`health_failed:${health.status}`);

  // Create a buyer API key so we can use Bearer auth without CSRF/cookies.
  const keyName = `smoke-${new Date().toISOString().replace(/[:.]/g, '')}`;
  const apiKeyResp = await fetchJson({
    baseUrl,
    path: '/api/org/api-keys',
    method: 'POST',
    body: { email, password, name: keyName },
  });
  if (!apiKeyResp.ok) throw new Error(`api_key_create_failed:${apiKeyResp.status}:${apiKeyResp.json?.error?.code ?? ''}`);
  const buyerToken = String(apiKeyResp.json?.token ?? '');
  if (!buyerToken) throw new Error('api_key_missing_token');

  const authHeader = { authorization: `Bearer ${buyerToken}` };

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
      allowedOrigins: ['https://example.com'],
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
  const pub = await fetchJson({ baseUrl, path: `/api/bounties/${encodeURIComponent(bountyId)}/publish`, method: 'POST', headers: authHeader });
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
