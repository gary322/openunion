// Remote app-suite smoke test for a deployed Proofwork environment.
//
// This script proves "apps work end-to-end with a real worker loop" by:
// - creating (or reusing) a buyer org + API key
// - publishing one bounty per built-in system app (excluding Travel)
// - running the OpenClaw-based Proofwork worker script once per app type
// - waiting for each job to reach done/pass
//
// Requirements (on the machine running this script):
// - `openclaw` installed and usable
// - a supported browser installed (Chrome/Brave/Edge/Chromium) for browser/screenshot jobs
// - `ffmpeg` installed for Clips
//
// Usage:
//   BASE_URL=https://... SMOKE_ADMIN_TOKEN=... npm run smoke:apps:remote
//
// Notes:
// - This does not print secrets. It prints only non-sensitive IDs/URLs.
// - This smoke expects the remote environment to have verifiers running so jobs transition to done/pass.

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

async function runBinaryChecked(cmd: string, args: string[], opts: { timeoutMs?: number } = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, timeoutMs);
    t.unref?.();
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      clearTimeout(t);
      if ((code ?? 1) !== 0) return reject(new Error(`${cmd}_failed:${code}:${stderr.slice(0, 200)}`));
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
    body: { email: input.email, password: input.password, name: `smoke-apps-${tsSuffix()}` },
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
      orgName: process.env.SMOKE_ORG_NAME ?? `Smoke Apps ${tsSuffix()}`,
      email,
      password,
      apiKeyName: process.env.SMOKE_API_KEY_NAME ?? 'default',
    },
  });

  if (!reg.ok) {
    const code = String(reg.json?.error?.message ?? '');
    if (reg.status === 409 && code.includes('email_already_registered')) {
      const retry = await fetchJson({
        baseUrl: input.baseUrl,
        path: '/api/org/api-keys',
        method: 'POST',
        body: { email, password, name: `smoke-apps-${tsSuffix()}` },
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

async function adminTopupBestEffort(input: { baseUrl: string; orgId: string; adminToken?: string; amountCents: number }) {
  if (!input.adminToken) return;
  await fetchJson({
    baseUrl: input.baseUrl,
    path: `/api/admin/billing/orgs/${encodeURIComponent(input.orgId)}/topup`,
    method: 'POST',
    headers: { authorization: `Bearer ${input.adminToken}` },
    body: { amountCents: input.amountCents },
  }).catch(() => undefined);
}

async function createAndPublishBounty(input: {
  baseUrl: string;
  buyerToken: string;
  title: string;
  payoutCents: number;
  taskDescriptor: any;
}): Promise<{ bountyId: string }> {
  const authHeader = { authorization: `Bearer ${input.buyerToken}` };
  const created = await fetchJson({
    baseUrl: input.baseUrl,
    path: '/api/bounties',
    method: 'POST',
    headers: authHeader,
    body: {
      title: input.title,
      description: 'app-suite smoke bounty',
      disputeWindowSec: 0,
      requiredProofs: 1,
      fingerprintClassesRequired: ['desktop_us'],
      payoutCents: input.payoutCents,
      taskDescriptor: input.taskDescriptor,
      // Intentionally omit allowedOrigins: system apps should supply supported origins.
    },
  });
  if (!created.ok) throw new Error(`bounty_create_failed:${created.status}:${created.text}`);
  const bountyId = String(created.json?.id ?? '').trim();
  if (!bountyId) throw new Error('bounty_create_missing_id');

  const pub = await fetchJson({
    baseUrl: input.baseUrl,
    path: `/api/bounties/${encodeURIComponent(bountyId)}/publish`,
    method: 'POST',
    headers: authHeader,
  });
  if (!pub.ok) {
    const code = String(pub.json?.error?.code ?? '');
    throw new Error(`bounty_publish_failed:${pub.status}:${code || pub.text}`);
  }
  return { bountyId };
}

async function firstJobIdForBounty(input: { baseUrl: string; buyerToken: string; bountyId: string }): Promise<string> {
  const authHeader = { authorization: `Bearer ${input.buyerToken}` };
  const jobs = await fetchJson({
    baseUrl: input.baseUrl,
    path: `/api/bounties/${encodeURIComponent(input.bountyId)}/jobs`,
    headers: authHeader,
  });
  if (!jobs.ok) throw new Error(`bounty_jobs_failed:${jobs.status}`);
  const jobId = String(jobs.json?.jobs?.[0]?.id ?? '').trim();
  if (!jobId) throw new Error('bounty_jobs_missing_job_id');
  return jobId;
}

async function waitJobDonePass(input: { baseUrl: string; buyerToken: string; bountyId: string; jobId: string; timeoutMs: number }) {
  const authHeader = { authorization: `Bearer ${input.buyerToken}` };
  const deadline = Date.now() + input.timeoutMs;
  for (;;) {
    const jobs = await fetchJson({
      baseUrl: input.baseUrl,
      path: `/api/bounties/${encodeURIComponent(input.bountyId)}/jobs`,
      headers: authHeader,
    });
    if (!jobs.ok) throw new Error(`bounty_jobs_poll_failed:${jobs.status}`);
    const job = (jobs.json?.jobs ?? []).find((j: any) => String(j?.id ?? '') === input.jobId) ?? null;
    const status = String(job?.status ?? '');
    const verdict = String(job?.finalVerdict ?? job?.final_verdict ?? '');
    if (status === 'done' && verdict === 'pass') return;
    if (Date.now() > deadline) throw new Error(`timeout_waiting_done_pass:${status}:${verdict}`);
    await sleep(1000);
  }
}

async function runOpenClawWorkerOnce(input: {
  baseUrl: string;
  workerTokenFile: string;
  openclawBin: string;
  browserProfile: string;
  supportedCapabilityTags: string[];
  requireTaskType: string;
  extraEnv?: Record<string, string>;
  timeoutMs: number;
}) {
  const env: Record<string, string> = {
    ...process.env,
    PROOFWORK_API_BASE_URL: input.baseUrl,
    PROOFWORK_WORKER_TOKEN_FILE: input.workerTokenFile,
    ONCE: 'true',
    WAIT_FOR_DONE: 'true',
    PROOFWORK_SUPPORTED_CAPABILITY_TAGS: input.supportedCapabilityTags.join(','),
    PROOFWORK_PREFER_CAPABILITY_TAG: input.supportedCapabilityTags.includes('llm_summarize') ? 'llm_summarize' : '',
    PROOFWORK_REQUIRE_TASK_TYPE: input.requireTaskType,
    PROOFWORK_CANARY_PERCENT: '100',
    PROOFWORK_NO_LOGIN: 'true',
    PROOFWORK_ORIGIN_ENFORCEMENT: 'strict',
    OPENCLAW_BIN: input.openclawBin,
    OPENCLAW_BROWSER_PROFILE: input.browserProfile,
    ...(input.extraEnv ?? {}),
  };

  await new Promise<void>((resolve, reject) => {
    const script = path.resolve(process.cwd(), 'integrations/openclaw/skills/proofwork-universal-worker/scripts/proofwork_worker.mjs');
    const child = spawn(process.execPath, [script], { env, stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => {
      const s = String(d);
      stderr += s;
      process.stderr.write(d);
    });
    child.on('error', (e) => reject(e));

    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, input.timeoutMs);
    t.unref?.();

    child.on('close', (code) => {
      clearTimeout(t);
      if ((code ?? 1) !== 0) return reject(new Error(`openclaw_worker_failed:${code}\n${stderr.slice(0, 2000)}`));
      resolve();
    });
  });
}

type AppSmoke = {
  id: string;
  taskType: string;
  payoutCents: number;
  supportedCapabilityTags: string[];
  taskDescriptor: any;
  extraWorkerEnv?: Record<string, string>;
  requiresBrowser?: boolean;
  requiresFfmpeg?: boolean;
};

async function main() {
  const baseUrl = normalizeBaseUrl(argValue('--base-url') ?? process.env.BASE_URL ?? '');
  if (!baseUrl) throw new Error('missing_BASE_URL');

  const smokeOrigin = new URL(baseUrl).origin;

  const adminToken = String(process.env.SMOKE_ADMIN_TOKEN ?? '').trim() || undefined;
  const openclawBin = String(process.env.OPENCLAW_BIN ?? 'openclaw').trim() || 'openclaw';
  const browserProfile = String(process.env.OPENCLAW_BROWSER_PROFILE ?? 'proofwork-worker-smoke').trim() || 'proofwork-worker-smoke';

  // Health
  const health = await fetchJson({ baseUrl, path: '/health' });
  if (!health.ok) throw new Error(`health_failed:${health.status}`);

  // Buyer auth
  const email = mustEnv('SMOKE_BUYER_EMAIL', 'buyer@example.com');
  const password = mustEnv('SMOKE_BUYER_PASSWORD', 'password');
  const auth = await ensureBuyerAuth({ baseUrl, email, password });
  const buyerToken = auth.buyerToken;

  // Ensure system apps expose the smoke origin in their supported origins (required for marketplace/clips determinism).
  const apps = await fetchJson({ baseUrl, path: '/api/apps' });
  if (!apps.ok) throw new Error(`apps_list_failed:${apps.status}`);
  const byTaskType = new Map<string, any>();
  for (const a of apps.json?.apps ?? []) {
    const t = String(a?.taskType ?? a?.task_type ?? '');
    if (t) byTaskType.set(t, a);
  }

  const requireSmokeOriginFor = ['marketplace_drops', 'clips_highlights'];
  for (const t of requireSmokeOriginFor) {
    const rec = byTaskType.get(t);
    const originsRaw = Array.isArray(rec?.publicAllowedOrigins)
      ? rec.publicAllowedOrigins
      : Array.isArray(rec?.public_allowed_origins)
        ? rec.public_allowed_origins
        : [];
    const origins = originsRaw.map((o: any) => String(o ?? '')).filter(Boolean);
    if (!origins.includes(smokeOrigin)) {
      throw new Error(`smoke_origin_not_supported_for:${t}: expected ${smokeOrigin} in app publicAllowedOrigins`);
    }
  }

  const smokes: AppSmoke[] = [
    {
      id: 'jobs',
      taskType: 'jobs_scrape',
      payoutCents: 900,
      supportedCapabilityTags: ['http', 'llm_summarize', 'screenshot'],
      requiresBrowser: true,
      taskDescriptor: {
        schema_version: 'v1',
        type: 'jobs_scrape',
        capability_tags: ['http', 'llm_summarize', 'screenshot'],
        input_spec: {
          titles: ['engineer'],
          location: 'remote',
          url: `${baseUrl}/__smoke/jobs/board`,
        },
        output_spec: { rows: true, markdown: true },
        freshness_sla_sec: 3600,
      },
      extraWorkerEnv: {
        REMOTIVE_API_URL: `${baseUrl}/__smoke/remotive/api/remote-jobs`,
      },
    },
    {
      id: 'research',
      taskType: 'arxiv_research_plan',
      payoutCents: 1100,
      supportedCapabilityTags: ['http', 'llm_summarize'],
      taskDescriptor: {
        schema_version: 'v1',
        type: 'arxiv_research_plan',
        capability_tags: ['http', 'llm_summarize'],
        input_spec: { idea: 'smoke: research plan', min_papers: 2 },
        output_spec: { references: true, report_md: true },
        freshness_sla_sec: 3600,
      },
      extraWorkerEnv: {
        ARXIV_API_BASE_URL: `${baseUrl}/__smoke/arxiv/api/query`,
      },
    },
    {
      id: 'github',
      taskType: 'github_scan',
      payoutCents: 1100,
      supportedCapabilityTags: ['http', 'llm_summarize'],
      taskDescriptor: {
        schema_version: 'v1',
        type: 'github_scan',
        capability_tags: ['http', 'llm_summarize'],
        input_spec: { idea: 'smoke: github scan', min_stars: 1 },
        output_spec: { repos: true, summary_md: true },
        freshness_sla_sec: 3600,
      },
      extraWorkerEnv: {
        // Worker supports base URLs with a path prefix (see proofwork_worker.mjs).
        GITHUB_API_BASE_URL: `${baseUrl}/__smoke/github`,
      },
    },
    {
      id: 'marketplace',
      taskType: 'marketplace_drops',
      payoutCents: 1200,
      supportedCapabilityTags: ['browser', 'screenshot'],
      requiresBrowser: true,
      taskDescriptor: {
        schema_version: 'v1',
        type: 'marketplace_drops',
        capability_tags: ['browser', 'screenshot'],
        input_spec: { query: 'smoke', url: `${baseUrl}/__smoke/marketplace/items?q=smoke` },
        output_spec: { results_json: true, screenshots: true },
        freshness_sla_sec: 600,
      },
    },
    {
      id: 'clips',
      taskType: 'clips_highlights',
      payoutCents: 1400,
      supportedCapabilityTags: ['ffmpeg', 'llm_summarize'],
      requiresFfmpeg: true,
      taskDescriptor: {
        schema_version: 'v1',
        type: 'clips_highlights',
        capability_tags: ['ffmpeg', 'llm_summarize'],
        input_spec: { vod_url: `${baseUrl}/__smoke/media/sample.mp4`, start_sec: 0, duration_sec: 3 },
        output_spec: { mp4: true, json_timeline: true },
        freshness_sla_sec: 3600,
      },
    },
  ];

  // Preflight local prerequisites so failures are actionable.
  await runBinaryChecked(openclawBin, ['--version'], { timeoutMs: 15_000 });
  const needsFfmpeg = smokes.some((s) => s.requiresFfmpeg);
  if (needsFfmpeg) await runBinaryChecked('ffmpeg', ['-version'], { timeoutMs: 10_000 });

  // Best-effort: ensure buyer has funds for publish. If insufficient, the publish call will fail loudly.
  if (adminToken && auth.orgId) await adminTopupBestEffort({ baseUrl, orgId: auth.orgId, adminToken, amountCents: 50_000 });

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'proofwork-smoke-apps-'));
  try {
    console.log(`[smoke_apps] base_url=${baseUrl}`);
    console.log(`[smoke_apps] smoke_origin=${smokeOrigin}`);
    console.log(`[smoke_apps] tmp_dir=${tmp}`);

    for (const s of smokes) {
      console.log(`[smoke_apps] create+publish ${s.id} (${s.taskType})`);
      const { bountyId } = await createAndPublishBounty({
        baseUrl,
        buyerToken,
        title: `Smoke ${s.id} ${tsSuffix()}`,
        payoutCents: s.payoutCents,
        taskDescriptor: s.taskDescriptor,
      });
      const jobId = await firstJobIdForBounty({ baseUrl, buyerToken, bountyId });
      console.log(`[smoke_apps] bounty_id=${bountyId} job_id=${jobId} task_type=${s.taskType}`);

      const tokenFile = path.join(tmp, `${s.id}-worker-token.json`);
      const workerTimeoutMs = Number(process.env.SMOKE_WORKER_TIMEOUT_MS ?? 12 * 60_000);

      await runOpenClawWorkerOnce({
        baseUrl,
        workerTokenFile: tokenFile,
        openclawBin,
        browserProfile,
        supportedCapabilityTags: s.supportedCapabilityTags,
        requireTaskType: s.taskType,
        extraEnv: s.extraWorkerEnv,
        timeoutMs: workerTimeoutMs,
      });

      console.log(`[smoke_apps] wait done/pass ${s.id}`);
      await waitJobDonePass({ baseUrl, buyerToken, bountyId, jobId, timeoutMs: 10 * 60_000 });
      console.log(`[smoke_apps] OK ${s.id}`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exitCode = 1;
});

