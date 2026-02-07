// Remote app-suite smoke test for a deployed Proofwork environment (OpenClaw plugin path).
//
// This script proves "a real OpenClaw Gateway with the proofwork-worker plugin can run multiple
// workers concurrently and complete one job per built-in app type (excluding Travel)".
//
// It runs OpenClaw in an isolated temp state dir and starts the Gateway in the foreground
// (`openclaw gateway run`), so it does NOT need to install a system service.
//
// Requirements (on the machine running this script):
// - `openclaw` installed and usable
// - a supported browser installed (Chrome/Brave/Edge/Chromium) for browser/screenshot jobs
// - `ffmpeg` installed for Clips
//
// Usage:
//   BASE_URL=https://... SMOKE_ADMIN_TOKEN=... npm run smoke:apps:plugin:remote
//
// Optional:
// - OPENCLAW_BIN=openclaw
// - SMOKE_PLUGIN_SPEC=@proofwork/proofwork-worker   (default: local path)
// - SMOKE_OPENCLAW_STATE_DIR=/tmp/...               (default: temp dir)
// - SMOKE_GATEWAY_PORT=18789                        (default: ephemeral free port)
// - SMOKE_GATEWAY_TOKEN=...                         (default: random)
// - SMOKE_BROWSER_PROFILE=proofwork-worker-smoke    (default: proofwork-worker-smoke)
//
// Notes:
// - This smoke expects the remote environment to have verifiers running so jobs transition to done/pass.
// - This does not print secrets.

import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
  return fallback;
}

function mustEnv(name: string, fallback?: string): string {
  const v = (process.env[name] ?? fallback ?? '').toString().trim();
  if (!v) throw new Error(`missing_${name}`);
  return v;
}

function normalizeBaseUrl(raw: string): string {
  return String(raw ?? '').trim().replace(/\/$/, '');
}

function tsSuffix() {
  return new Date().toISOString().replace(/[:.]/g, '');
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

async function pickFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref?.();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : null;
      server.close(() => {
        if (!port) return reject(new Error('failed_to_pick_port'));
        resolve(Number(port));
      });
    });
  });
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

async function resolveBrowserExecutablePath(): Promise<string | null> {
  const explicit = String(process.env.SMOKE_BROWSER_EXECUTABLE_PATH ?? '').trim();
  if (explicit) return explicit;

  // If the repo has Playwright installed, prefer its pinned Chromium binary (no system browser install required).
  try {
    const mod: any = await import('playwright');
    const p = typeof mod?.chromium?.executablePath === 'function' ? String(mod.chromium.executablePath() ?? '').trim() : '';
    if (p && fs.existsSync(p)) return p;
  } catch {
    // ignore
  }

  // Fall back to common macOS locations if present.
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // ignore
    }
  }

  return null;
}

async function runCommandChecked(
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number; redactArgs?: boolean } = {}
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const env = { ...process.env, ...(opts.env ?? {}) } as Record<string, string>;
  const printable = opts.redactArgs ? `${cmd} <redacted args>` : `${cmd} ${args.join(' ')}`.trim();

  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, timeoutMs);
    t.unref?.();
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(t);
      if ((code ?? 1) !== 0) return reject(new Error(`command_failed:${printable}:exit_${code}\n${(stderr || stdout).slice(0, 2000)}`));
      resolve({ stdout, stderr });
    });
  });
}

async function ensureBuyerAuth(input: {
  baseUrl: string;
  email: string;
  password: string;
}): Promise<{ buyerToken: string; orgId?: string; email: string; password: string }> {
  const apiKeyResp = await fetchJson({
    baseUrl: input.baseUrl,
    path: '/api/org/api-keys',
    method: 'POST',
    body: { email: input.email, password: input.password, name: `smoke-apps-plugin-${tsSuffix()}` },
  });
  if (apiKeyResp.ok) {
    const buyerToken = String(apiKeyResp.json?.token ?? '');
    if (!buyerToken) throw new Error('api_key_missing_token');
    return { buyerToken, email: input.email, password: input.password };
  }

  // Self-serve register.
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
      orgName: process.env.SMOKE_ORG_NAME ?? `Smoke Apps Plugin ${tsSuffix()}`,
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
        body: { email, password, name: `smoke-apps-plugin-${tsSuffix()}` },
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

async function adminTopupBestEffort(input: {
  baseUrl: string;
  orgId: string;
  adminToken?: string;
  amountCents: number;
}) {
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
      description: 'app-suite smoke bounty (plugin)',
      disputeWindowSec: 0,
      requiredProofs: 1,
      fingerprintClassesRequired: ['desktop_us'],
      payoutCents: input.payoutCents,
      taskDescriptor: input.taskDescriptor,
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

async function waitJobDonePass(input: {
  baseUrl: string;
  buyerToken: string;
  bountyId: string;
  jobId: string;
  timeoutMs: number;
}) {
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

type WorkerStatus = { statusFile: string; status: any };

async function waitForPluginWorkers(input: { stateDir: string; timeoutMs: number; maxAgeMs: number; expectNames: string[] }): Promise<Record<string, WorkerStatus>> {
  const start = Date.now();
  const pluginRoot = path.join(input.stateDir, 'plugins', 'proofwork-worker');

  const candidateStatusFiles = (): string[] => {
    const out: string[] = [];
    try {
      if (!fs.existsSync(pluginRoot)) return out;
      const dirs = fs.readdirSync(pluginRoot, { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const dir = path.join(pluginRoot, d.name);
        const files = fs.readdirSync(dir, { withFileTypes: true });
        for (const f of files) {
          if (!f.isFile()) continue;
          if (!f.name.startsWith('status.')) continue;
          if (!f.name.endsWith('.json')) continue;
          out.push(path.join(dir, f.name));
        }
      }
    } catch {
      // ignore
    }
    return Array.from(new Set(out));
  };

  const isFreshEnough = (st: any) => {
    const lastPollAt = typeof st?.lastPollAt === 'number' ? st.lastPollAt : null;
    if (!lastPollAt) return false;
    if (Date.now() - lastPollAt > input.maxAgeMs) return false;
    return true;
  };

  while (Date.now() - start < input.timeoutMs) {
    const found: Record<string, WorkerStatus> = {};
    for (const p of candidateStatusFiles()) {
      try {
        const raw = fs.readFileSync(p, 'utf8');
        const json = JSON.parse(raw);
        const workerId = typeof json?.workerId === 'string' ? json.workerId : '';
        if (!workerId) continue;
        if (json?.paused === true) continue;
        if (!isFreshEnough(json)) continue;
        const name = typeof json?.workerName === 'string' && json.workerName.trim() ? json.workerName.trim() : path.basename(p);
        found[name] = { statusFile: p, status: json };
      } catch {
        // ignore
      }
    }

    const ok = input.expectNames.every((n) => Object.keys(found).some((k) => k.toLowerCase().includes(n.toLowerCase())));
    if (ok) return found;
    await sleep(250);
  }

  throw new Error('plugin_workers_status_timeout');
}

async function main() {
  const baseUrl = normalizeBaseUrl(mustEnv('BASE_URL'));
  const smokeOrigin = new URL(baseUrl).origin;

  const adminToken = String(process.env.SMOKE_ADMIN_TOKEN ?? '').trim() || undefined;

  const openclawBin = String(process.env.OPENCLAW_BIN ?? 'openclaw').trim() || 'openclaw';
  const browserProfile = String(process.env.SMOKE_BROWSER_PROFILE ?? 'proofwork-worker-smoke').trim() || 'proofwork-worker-smoke';
  const pluginSpec = String(process.env.SMOKE_PLUGIN_SPEC ?? path.resolve(process.cwd(), 'integrations/openclaw/extensions/proofwork-worker')).trim();

  const stateDir = String(process.env.SMOKE_OPENCLAW_STATE_DIR ?? '').trim()
    ? String(process.env.SMOKE_OPENCLAW_STATE_DIR).trim()
    : await mkdtemp(path.join(os.tmpdir(), 'proofwork-openclaw-state-'));

  const port = process.env.SMOKE_GATEWAY_PORT ? Number(process.env.SMOKE_GATEWAY_PORT) : await pickFreePort();
  if (!Number.isFinite(port) || port <= 0) throw new Error('invalid_gateway_port');

  const gwToken = String(process.env.SMOKE_GATEWAY_TOKEN ?? `gw_${randomBytes(16).toString('hex')}`);
  const gwUrl = `ws://127.0.0.1:${port}`;

  const ocEnv = { ...process.env, OPENCLAW_STATE_DIR: stateDir } as Record<string, string>;

  // Preflight: Proofwork health + local prerequisites.
  const health = await fetchJson({ baseUrl, path: '/health' });
  if (!health.ok) throw new Error(`health_failed:${health.status}`);
  await runCommandChecked(openclawBin, ['--version'], { timeoutMs: 15_000, env: ocEnv });
  await runCommandChecked('ffmpeg', ['-version'], { timeoutMs: 10_000 });

  // Install plugin into the isolated OpenClaw state.
  await runCommandChecked(openclawBin, ['plugins', 'install', pluginSpec], { timeoutMs: 5 * 60_000, env: ocEnv });

  // Configure OpenClaw browser execution to avoid requiring a system-installed browser and to avoid opening windows.
  const headless = parseBoolEnv('SMOKE_BROWSER_HEADLESS', true);
  const exePath = await resolveBrowserExecutablePath();
  if (exePath) {
    console.log(`[smoke_apps_plugin] openclaw_browser_executable_path=${exePath}`);
    await runCommandChecked(openclawBin, ['config', 'set', '--json', 'browser.executablePath', JSON.stringify(exePath)], { timeoutMs: 15_000, env: ocEnv });
  } else {
    console.log('[smoke_apps_plugin] openclaw_browser_executable_path not set (auto-detect). If browser jobs fail, set SMOKE_BROWSER_EXECUTABLE_PATH.');
  }
  await runCommandChecked(openclawBin, ['config', 'set', '--json', 'browser.headless', JSON.stringify(headless)], { timeoutMs: 15_000, env: ocEnv });

  // Minimal gateway config.
  await runCommandChecked(openclawBin, ['config', 'set', '--json', 'gateway.mode', JSON.stringify('local')], { timeoutMs: 15_000, env: ocEnv });
  await runCommandChecked(openclawBin, ['config', 'set', '--json', 'gateway.auth.mode', JSON.stringify('token')], { timeoutMs: 15_000, env: ocEnv });
  await runCommandChecked(openclawBin, ['config', 'set', '--json', 'gateway.auth.token', JSON.stringify(gwToken)], { timeoutMs: 15_000, env: ocEnv, redactArgs: true });
  await runCommandChecked(openclawBin, ['config', 'set', '--json', 'gateway.remote.token', JSON.stringify(gwToken)], { timeoutMs: 15_000, env: ocEnv, redactArgs: true });
  await runCommandChecked(openclawBin, ['config', 'set', '--json', 'gateway.remote.url', JSON.stringify(gwUrl)], { timeoutMs: 15_000, env: ocEnv });
  await runCommandChecked(openclawBin, ['config', 'set', '--json', 'gateway.port', String(port)], { timeoutMs: 15_000, env: ocEnv });

  // Configure plugin (multi-worker preset).
  const pluginCfg = {
    apiBaseUrl: baseUrl,
    openclawBin,
    browserProfile,
    workerDisplayName: os.hostname(),
    workers: [
      { name: 'jobs', enabled: true, allowTaskTypes: ['jobs_scrape'], supportedCapabilityTags: ['browser', 'screenshot', 'http', 'llm_summarize'] },
      { name: 'research', enabled: true, allowTaskTypes: ['arxiv_research_plan'], supportedCapabilityTags: ['http', 'llm_summarize'] },
      { name: 'github', enabled: true, allowTaskTypes: ['github_scan'], supportedCapabilityTags: ['http', 'llm_summarize'] },
      { name: 'marketplace', enabled: true, allowTaskTypes: ['marketplace_drops'], supportedCapabilityTags: ['browser', 'screenshot'] },
      { name: 'clips', enabled: true, allowTaskTypes: ['clips_highlights'], supportedCapabilityTags: ['ffmpeg', 'llm_summarize'] },
    ],
  };
  await runCommandChecked(openclawBin, ['config', 'set', '--json', 'plugins.enabled', 'true'], { timeoutMs: 15_000, env: ocEnv });
  await runCommandChecked(openclawBin, ['config', 'set', '--json', 'plugins.entries.proofwork-worker.enabled', 'true'], { timeoutMs: 15_000, env: ocEnv });
  await runCommandChecked(openclawBin, ['config', 'set', '--json', 'plugins.entries.proofwork-worker.config', JSON.stringify(pluginCfg)], { timeoutMs: 15_000, env: ocEnv });

  // Start gateway in the background (foreground mode). Plugin auto-starts workers.
  const gw = spawn(openclawBin, ['gateway', 'run', '--port', String(port), '--token', gwToken, '--bind', 'loopback', '--allow-unconfigured', '--force', '--compact'], {
    env: ocEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const gwLogs: string[] = [];
  const onGwLine = (s: string) => {
    const line = s.trimEnd();
    if (!line) return;
    gwLogs.push(line);
    if (gwLogs.length > 2000) gwLogs.shift();
  };
  let bufOut = '';
  gw.stdout.on('data', (d) => {
    bufOut += String(d);
    for (;;) {
      const idx = bufOut.indexOf('\n');
      if (idx === -1) break;
      const line = bufOut.slice(0, idx);
      bufOut = bufOut.slice(idx + 1);
      onGwLine(line);
    }
  });
  let bufErr = '';
  gw.stderr.on('data', (d) => {
    bufErr += String(d);
    for (;;) {
      const idx = bufErr.indexOf('\n');
      if (idx === -1) break;
      const line = bufErr.slice(0, idx);
      bufErr = bufErr.slice(idx + 1);
      onGwLine(line);
    }
  });

  const killGateway = async () => {
    try {
      gw.kill('SIGTERM');
    } catch {
      // ignore
    }
    await sleep(250);
    try {
      gw.kill('SIGKILL');
    } catch {
      // ignore
    }
  };

  try {
    // Wait for gateway health.
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await runCommandChecked(openclawBin, ['gateway', 'health', '--url', gwUrl, '--token', gwToken, '--json'], { timeoutMs: 10_000, env: ocEnv, redactArgs: true });
        break;
      } catch (err) {
        if (Date.now() > deadline) throw new Error(`openclaw_gateway_health_timeout:${String((err as any)?.message ?? err)}`);
        await sleep(500);
      }
    }

    // Ensure browser can start for the configured profile (fails fast rather than timing out later).
    await runCommandChecked(openclawBin, ['browser', '--browser-profile', browserProfile, 'start', '--json'], { timeoutMs: 60_000, env: ocEnv });

    // Ensure system apps expose the smoke origin for determinism (Marketplace/Clips at minimum).
    const apps = await fetchJson({ baseUrl, path: '/api/apps' });
    if (!apps.ok) throw new Error(`apps_list_failed:${apps.status}`);
    const byTaskType = new Map<string, any>();
    for (const a of apps.json?.apps ?? []) {
      const t = String(a?.taskType ?? a?.task_type ?? '');
      if (t) byTaskType.set(t, a);
    }
    for (const t of ['marketplace_drops', 'clips_highlights']) {
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

    // Wait for plugin workers to start and report status.
    await waitForPluginWorkers({ stateDir, timeoutMs: 60_000, maxAgeMs: 30_000, expectNames: ['jobs', 'research', 'github', 'marketplace', 'clips'] });

    // Buyer auth + ensure funds.
    const email = mustEnv('SMOKE_BUYER_EMAIL', 'buyer@example.com');
    const password = mustEnv('SMOKE_BUYER_PASSWORD', 'password');
    const auth = await ensureBuyerAuth({ baseUrl, email, password });
    if (adminToken && auth.orgId) await adminTopupBestEffort({ baseUrl, orgId: auth.orgId, adminToken, amountCents: 50_000 });

    const buyerToken = auth.buyerToken;

    const smokes = [
      {
        id: 'jobs',
        taskType: 'jobs_scrape',
        payoutCents: 900,
        td: {
          schema_version: 'v1',
          type: 'jobs_scrape',
          capability_tags: ['http', 'llm_summarize', 'screenshot'],
          input_spec: { titles: ['engineer'], location: 'remote', url: `${baseUrl}/__smoke/jobs/board` },
          output_spec: { rows: true, markdown: true },
          freshness_sla_sec: 3600,
        },
      },
      {
        id: 'research',
        taskType: 'arxiv_research_plan',
        payoutCents: 1100,
        td: {
          schema_version: 'v1',
          type: 'arxiv_research_plan',
          capability_tags: ['http', 'llm_summarize'],
          input_spec: { idea: 'smoke: research plan', min_papers: 2 },
          output_spec: { references: true, report_md: true },
          freshness_sla_sec: 3600,
        },
      },
      {
        id: 'github',
        taskType: 'github_scan',
        payoutCents: 1100,
        td: {
          schema_version: 'v1',
          type: 'github_scan',
          capability_tags: ['http', 'llm_summarize'],
          input_spec: { idea: 'smoke: github scan', min_stars: 1 },
          output_spec: { repos: true, summary_md: true },
          freshness_sla_sec: 3600,
        },
      },
      {
        id: 'marketplace',
        taskType: 'marketplace_drops',
        payoutCents: 1200,
        td: {
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
        td: {
          schema_version: 'v1',
          type: 'clips_highlights',
          capability_tags: ['ffmpeg', 'llm_summarize'],
          input_spec: { vod_url: `${baseUrl}/__smoke/media/sample.mp4`, start_sec: 0, duration_sec: 3 },
          output_spec: { mp4: true, json_timeline: true },
          freshness_sla_sec: 3600,
        },
      },
    ];

    // Create all bounties first, then wait for completion. This better exercises "multi workers in parallel".
    const jobs: Array<{ id: string; taskType: string; bountyId: string; jobId: string }> = [];
    for (const s of smokes) {
      const { bountyId } = await createAndPublishBounty({
        baseUrl,
        buyerToken,
        title: `Smoke(plugin) ${s.id} ${tsSuffix()}`,
        payoutCents: s.payoutCents,
        taskDescriptor: s.td,
      });
      const jobId = await firstJobIdForBounty({ baseUrl, buyerToken, bountyId });
      jobs.push({ id: s.id, taskType: s.taskType, bountyId, jobId });
    }

    // Wait for all jobs to finish.
    const timeoutMs = Number(process.env.SMOKE_JOB_TIMEOUT_MS ?? 12 * 60_000);
    for (const j of jobs) {
      await waitJobDonePass({ baseUrl, buyerToken, bountyId: j.bountyId, jobId: j.jobId, timeoutMs });
    }
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    // Include the last gateway log lines for debugging without dumping secrets.
    const tail = gwLogs.slice(-60).join('\n');
    throw new Error(`${msg}\n\n[openclaw_gateway_tail]\n${tail}`);
  } finally {
    await killGateway();
    // Best-effort cleanup of isolated OpenClaw state dir unless user provided it.
    if (!process.env.SMOKE_OPENCLAW_STATE_DIR) {
      await rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exitCode = 1;
});
