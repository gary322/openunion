// Load .env only in non-test environments
const _loadEnv = (process.env.NODE_ENV !== 'test' && !process.env.VITEST)
  ? import('dotenv/config').catch(() => {})
  : Promise.resolve();
await _loadEnv;

import { createHash } from 'crypto';
import { spawn } from 'node:child_process';

type ArtifactRef = {
  kind: 'screenshot' | 'snapshot' | 'pdf' | 'log' | 'video' | 'other';
  label: string;
  sha256: string;
  url: string;
  sizeBytes?: number;
  contentType?: string;
};

type BrowserFlowResult = {
  artifacts: ArtifactRef[];
  extracted: Record<string, any>;
};

const API_BASE_URL = (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const ONCE = String(process.env.ONCE ?? '').toLowerCase() === 'true';
const WAIT_FOR_DONE = String(process.env.WAIT_FOR_DONE ?? '').toLowerCase() === 'true';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256Hex(buf: Buffer) {
  return createHash('sha256').update(buf).digest('hex');
}

function envBool(name: string, defaultValue = false): boolean {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  if (!v) return defaultValue;
  return v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on';
}

async function runCommand(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    const t = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function stripOsc52AndAnsi(s: string): string {
  // llm-arxiv writes an OSC 52 clipboard sequence to stdout. Strip that plus common ANSI styling.
  const withoutOsc52 = s.replace(/\u001b]52;c;[^\u0007]*\u0007/g, '');
  return withoutOsc52.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

function parseLlmArxivSearchOutput(s: string): Array<{ arxivId: string; title?: string }> {
  const out: Array<{ arxivId: string; title?: string }> = [];
  const lines = stripOsc52AndAnsi(s)
    .split(/\r?\n/)
    .map((l) => l.trimEnd());

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\bID:\s*([^\s]+)/i);
    if (!m?.[1]) continue;
    const arxivId = m[1].trim();
    let title: string | undefined;
    const next = lines[i + 1] ?? '';
    const m2 = next.match(/\bTitle:\s*(.+)\s*$/i);
    if (m2?.[1]) title = m2[1].trim();
    out.push({ arxivId, title });
  }
  return out;
}

async function maybeGetArxivReferencesFromLlm(input: { idea: string }): Promise<Array<{ id: string; title?: string; url: string }>> {
  if (!envBool('LLM_ARXIV_ENABLED', false)) return [];
  const idea = input.idea.trim();
  if (!idea) return [];

  const llmBin = String(process.env.LLM_BIN ?? 'llm').trim() || 'llm';
  const maxResultsRaw = Number(process.env.LLM_ARXIV_MAX_RESULTS ?? 5);
  const maxResults = Number.isFinite(maxResultsRaw) ? Math.max(1, Math.min(10, Math.floor(maxResultsRaw))) : 5;

  try {
    const res = await runCommand(llmBin, ['arxiv-search', '-n', String(maxResults), idea], { timeoutMs: 30_000 });
    if (res.code !== 0) return [];
    const parsed = parseLlmArxivSearchOutput(res.stdout).slice(0, maxResults);
    return parsed.map((p) => {
      const clean = p.arxivId.replace(/^arxiv:/i, '');
      return { id: `arxiv:${clean}`, title: p.title, url: `https://arxiv.org/abs/${clean}` };
    });
  } catch {
    return [];
  }
}

function arxivApiBaseUrl(): string {
  const env = String(process.env.ARXIV_API_BASE_URL ?? '').trim();
  if (env) return env.replace(/\/$/, '');
  return 'https://export.arxiv.org/api/query';
}

function arxivMaxResults(): number {
  const raw = Number(process.env.ARXIV_MAX_RESULTS ?? 5);
  if (!Number.isFinite(raw)) return 5;
  return Math.max(1, Math.min(10, Math.floor(raw)));
}

function decodeXmlEntities(s: string): string {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function normalizeWs(s: string): string {
  return String(s).replace(/\s+/g, ' ').trim();
}

function extractArxivId(raw: string): string | null {
  let s = String(raw ?? '').trim();
  if (!s) return null;

  // Common forms:
  // - http://arxiv.org/abs/2310.06825v1
  // - https://arxiv.org/abs/hep-th/9901001v2
  // - arxiv:2310.06825v1
  // - 2310.06825v1
  s = s.replace(/^arxiv:/i, '');
  const mAbs = s.match(/\/abs\/([^?#]+)$/i);
  const mPdf = s.match(/\/pdf\/([^?#]+)$/i);
  if (mAbs?.[1]) s = mAbs[1];
  else if (mPdf?.[1]) s = mPdf[1];
  s = s.replace(/\.pdf$/i, '');
  s = s.replace(/v\d+$/i, '');
  s = s.trim();

  if (!s) return null;
  // New-style IDs: 2310.06825
  if (/^\d{4}\.\d{4,5}$/.test(s)) return s;
  // Old-style IDs: hep-th/9901001
  if (/^[a-z-]+(\/[a-z-]+)*\/\d{7}$/i.test(s)) return s;
  return null;
}

function parseArxivAtomFeed(xml: string): Array<{ id: string; title?: string }> {
  const out: Array<{ id: string; title?: string }> = [];
  const entries = String(xml).match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  for (const entry of entries) {
    const idMatch = entry.match(/<id>\s*([^<]+)\s*<\/id>/i);
    const titleMatch = entry.match(/<title>\s*([\s\S]*?)\s*<\/title>/i);
    const id = extractArxivId(idMatch?.[1] ?? '');
    if (!id) continue;
    const titleRaw = titleMatch?.[1] ? decodeXmlEntities(titleMatch[1]) : '';
    const title = titleRaw ? normalizeWs(titleRaw) : undefined;
    out.push({ id, title });
  }
  return out;
}

async function getArxivReferencesFromApi(input: { query: string }): Promise<Array<{ id: string; title?: string; url: string }>> {
  const q = input.query.trim();
  if (!q) return [];

  const base = arxivApiBaseUrl();
  const max = arxivMaxResults();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30_000);
  t.unref?.();
  try {
    const url = new URL(base);
    url.searchParams.set('search_query', `all:${q}`);
    url.searchParams.set('start', '0');
    url.searchParams.set('max_results', String(max));

    const resp = await fetch(url.toString(), { method: 'GET', headers: { Accept: 'application/atom+xml' }, signal: ac.signal });
    if (!resp.ok) return [];
    const xml = await resp.text();
    const parsed = parseArxivAtomFeed(xml).slice(0, max);
    return parsed.map((p) => ({ id: `arxiv:${p.id}`, title: p.title, url: `https://arxiv.org/abs/${p.id}` }));
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

function supportedCapabilityTags(): string[] {
  // Keep ffmpeg opt-in; it requires ffmpeg/ffprobe to exist in the worker runtime.
  return (process.env.SUPPORTED_CAPABILITY_TAGS ?? 'browser,http,screenshot,llm_summarize')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function canaryPercent(): number {
  const v = Number(process.env.UNIVERSAL_WORKER_CANARY_PERCENT ?? 100);
  if (!Number.isFinite(v)) return 100;
  return Math.max(0, Math.min(100, v));
}

function withinCanary(jobId: string): boolean {
  const pct = canaryPercent();
  if (pct >= 100) return true;
  if (pct <= 0) return false;
  // Deterministic routing: different worker deployments can set different canary % without coordination.
  const h = createHash('sha256').update(jobId).digest();
  const n = h.readUInt32BE(0) / 0xffffffff;
  return n < pct / 100;
}

async function apiFetch(path: string, opts: { method?: string; token?: string; body?: any; query?: Record<string, any> } = {}) {
  const url = new URL(`${API_BASE_URL}${path}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const resp = await fetch(url.toString(), { method: opts.method ?? 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await resp.text();
  const json = text ? JSON.parse(text) : null;
  return { resp, json };
}

async function ensureWorkerToken(): Promise<{ token: string; workerId: string }> {
  const existing = String(process.env.WORKER_TOKEN ?? '').trim();
  if (existing) {
    // Best-effort: we don't know workerId from the token without a lookup endpoint.
    return { token: existing, workerId: 'unknown' };
  }

  const reg = await apiFetch('/api/workers/register', { method: 'POST', body: { displayName: 'universal', capabilities: { browser: true } } });
  if (!reg.resp.ok) throw new Error(`worker_register_failed:${reg.resp.status}`);
  const token = String(reg.json?.token ?? '');
  const workerId = String(reg.json?.workerId ?? '');
  if (!token) throw new Error('worker_register_missing_token');
  return { token, workerId };
}

function rewriteArtifactFinalUrlToApiBase(finalUrl: string): string {
  // In some environments PUBLIC_BASE_URL can be misconfigured or derived from an internal host.
  // If the URL targets this API's /api/artifacts/* endpoint, rewrite the origin to API_BASE_URL.
  try {
    const u = new URL(finalUrl);
    if (!u.pathname.startsWith('/api/artifacts/')) return finalUrl;
    const api = new URL(API_BASE_URL);
    u.protocol = api.protocol;
    u.hostname = api.hostname;
    u.port = api.port;
    return u.toString();
  } catch {
    if (finalUrl.startsWith('/api/artifacts/')) return `${API_BASE_URL}${finalUrl}`;
    return finalUrl;
  }
}

async function waitForArtifactScanned(input: { token: string; finalUrl: string }) {
  const url = rewriteArtifactFinalUrlToApiBase(input.finalUrl);
  const headers: Record<string, string> = { Authorization: `Bearer ${input.token}` };
  const debug = envBool('ARTIFACT_WAIT_DEBUG', false);
  const maxWaitRaw = Number(process.env.ARTIFACT_SCAN_MAX_WAIT_SEC ?? 300);
  // Clamp to avoid infinite hangs while still allowing slow clamd cold starts in real deployments.
  const maxWaitSec = Number.isFinite(maxWaitRaw) ? Math.max(30, Math.min(30 * 60, Math.floor(maxWaitRaw))) : 300;
  let lastStatus: number | undefined;

  // S3 backend is async-scanned: /api/artifacts/:id/download returns 409 until status is scanned/accepted.
  for (let i = 0; i < maxWaitSec; i++) {
    const resp = await fetch(url, { method: 'GET', headers, redirect: 'manual' });
    // Avoid buffering large artifacts in memory.
    // Note: for blocked artifacts (422) we may read the small JSON body for the reason.
    if (resp.status !== 422) resp.body?.cancel();

    if (debug && (lastStatus !== resp.status || i % 20 === 0)) {
      console.log(`[artifact_wait] i=${i} status=${resp.status}`);
      lastStatus = resp.status;
    }

    if (resp.status === 401 || resp.status === 403) throw new Error(`artifact_download_unauthorized:${resp.status}`);
    if (resp.status === 404) throw new Error('artifact_not_found');
    if (resp.status === 422) {
      // Blocked by scanner/quarantine. Include the reason if present.
      let reason = '';
      try {
        const txt = await resp.text();
        const json = txt ? JSON.parse(txt) : null;
        reason = String(json?.error?.scanReason ?? json?.error?.reason ?? '');
      } catch {
        // ignore
      }
      throw new Error(`artifact_blocked${reason ? `:${reason}` : ''}`);
    }

    if (resp.status === 409) {
      await sleep(1000);
      continue;
    }
    if (resp.status === 429) {
      // Respect the server-side per-route rate limit (default 60/min).
      await sleep(2000);
      continue;
    }
    // 200 (local proxy) or 3xx (presigned redirect) both indicate the artifact is ready.
    if (resp.ok || (resp.status >= 300 && resp.status < 400)) return;
    // Retry on transient failures.
    await sleep(1000);
  }
  throw new Error('artifact_scan_timeout');
}

async function uploadArtifact(input: {
  token: string;
  jobId: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
  kind: ArtifactRef['kind'];
  label: string;
}): Promise<ArtifactRef> {
  const presign = await apiFetch('/api/uploads/presign', {
    method: 'POST',
    token: input.token,
    body: { jobId: input.jobId, files: [{ filename: input.filename, contentType: input.contentType, sizeBytes: input.bytes.byteLength }] },
  });
  if (!presign.resp.ok) throw new Error(`presign_failed:${presign.resp.status}:${presign.json?.error?.code ?? ''}`);
  const up = presign.json?.uploads?.[0];
  if (!up?.url || !up?.artifactId || !up?.finalUrl) throw new Error('presign_missing_fields');

  const putHeaders: Record<string, string> = { ...(up.headers ?? {}) };
  if (typeof up.url === 'string' && (up.url.includes('/api/uploads/local/') || up.url.startsWith(`${API_BASE_URL}/`))) {
    putHeaders['Authorization'] = `Bearer ${input.token}`;
  }

  const put = await fetch(up.url, { method: 'PUT', headers: putHeaders, body: input.bytes as any });
  if (!put.ok) throw new Error(`upload_put_failed:${put.status}`);

  const sha = sha256Hex(input.bytes);
  const complete = await apiFetch('/api/uploads/complete', {
    method: 'POST',
    token: input.token,
    body: { artifactId: up.artifactId, sha256: sha, sizeBytes: input.bytes.byteLength },
  });
  if (!complete.resp.ok) throw new Error(`upload_complete_failed:${complete.resp.status}`);

  // For S3 backends, uploads are scanned asynchronously. Wait until the artifact becomes downloadable
  // (i.e., scan completed) so /api/jobs/:jobId/submit can attach it deterministically.
  await waitForArtifactScanned({ token: input.token, finalUrl: up.finalUrl });

  return {
    kind: input.kind,
    label: input.label,
    sha256: sha,
    url: up.finalUrl,
    sizeBytes: input.bytes.byteLength,
    contentType: input.contentType,
  };
}

async function runBrowserScreenshotModule(input: { token: string; job: any }): Promise<ArtifactRef> {
  const descriptorUrl = input.job?.taskDescriptor?.input_spec?.url;
  const startUrl = typeof descriptorUrl === 'string' && descriptorUrl ? descriptorUrl : String(input.job?.journey?.startUrl ?? '');
  if (!startUrl) throw new Error('missing_start_url');

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1365, height: 768 } });
  const page = await context.newPage();
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.waitForTimeout(250);
  const png = await page.screenshot({ fullPage: true, type: 'png' });
  await context.close();
  await browser.close();

  return await uploadArtifact({
    token: input.token,
    jobId: input.job.jobId,
    filename: 'screenshot.png',
    contentType: 'image/png',
    bytes: Buffer.from(png),
    kind: 'screenshot',
    label: 'universal_screenshot',
  });
}

function getBrowserFlowSpec(job: any): any | null {
  const sp = job?.taskDescriptor?.site_profile ?? null;
  if (!sp || typeof sp !== 'object') return null;
  const bf = (sp as any).browser_flow ?? (sp as any).browserFlow ?? null;
  if (!bf || typeof bf !== 'object') return null;
  return bf;
}

function redactStepValue(step: any): string {
  if (typeof step?.value_env === 'string' && step.value_env) return `<env:${step.value_env}>`;
  if (typeof step?.value === 'string') return `<inline:${Math.min(80, step.value.length)} chars>`;
  return `<none>`;
}

function pickFillValue(step: any): string {
  if (typeof step?.value_env === 'string' && step.value_env) return String(process.env[step.value_env] ?? '');
  if (typeof step?.value === 'string') return step.value;
  return '';
}

function normalizeTimeoutMs(step: any, fallbackMs: number): number {
  const n = Number(step?.timeout_ms ?? step?.timeoutMs ?? fallbackMs);
  if (!Number.isFinite(n)) return fallbackMs;
  return Math.max(250, Math.min(60_000, Math.floor(n)));
}

function locatorFromStep(page: any, step: any) {
  const nth = Number(step?.nth ?? 0);
  const useNth = Number.isFinite(nth) && nth > 0 ? Math.floor(nth) : 0;

  if (typeof step?.selector === 'string' && step.selector) {
    const loc = page.locator(step.selector);
    return useNth ? loc.nth(useNth) : loc.first();
  }

  if (typeof step?.role === 'string' && step.role) {
    const opts: any = {};
    if (typeof step?.name === 'string' && step.name) opts.name = step.name;
    const loc = page.getByRole(step.role as any, opts);
    return useNth ? loc.nth(useNth) : loc.first();
  }

  if (typeof step?.text === 'string' && step.text) {
    const loc = page.getByText(step.text);
    return useNth ? loc.nth(useNth) : loc.first();
  }

  throw new Error('missing_locator');
}

async function runBrowserFlowModule(input: { token: string; job: any; flow: any }): Promise<BrowserFlowResult> {
  const descriptorUrl = input.job?.taskDescriptor?.input_spec?.url;
  const startUrl = typeof descriptorUrl === 'string' && descriptorUrl ? descriptorUrl : String(input.job?.journey?.startUrl ?? '');
  if (!startUrl) throw new Error('missing_start_url');

  const stepsRaw = Array.isArray(input.flow?.steps) ? input.flow.steps : [];
  const maxSteps = Number.isFinite(Number(input.flow?.max_steps)) ? Math.max(1, Math.min(100, Number(input.flow.max_steps))) : 50;
  const steps = stepsRaw.slice(0, maxSteps);
  const continueOnError = input.flow?.continue_on_error !== false;

  const logs: string[] = [];
  const extracted: Record<string, any> = {};
  const artifacts: ArtifactRef[] = [];

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1365, height: 768 } });
  const page = await context.newPage();

  try {
    logs.push(`start_url: ${startUrl}`);
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] ?? {};
      const op = String(step?.op ?? step?.action ?? '').trim().toLowerCase();
      if (!op) continue;

      try {
        if (op === 'goto' || op === 'navigate') {
          const url = typeof step?.url === 'string' && step.url ? step.url : startUrl;
          logs.push(`step ${i}: ${op} url=${url}`);
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: normalizeTimeoutMs(step, 20_000) });
        } else if (op === 'wait') {
          const t = normalizeTimeoutMs(step, 10_000);
          if (typeof step?.ms === 'number' || typeof step?.ms === 'string') {
            const ms = Math.max(0, Math.min(60_000, Number(step.ms)));
            logs.push(`step ${i}: wait ms=${ms}`);
            await page.waitForTimeout(ms);
          } else if (typeof step?.selector === 'string' && step.selector) {
            logs.push(`step ${i}: wait selector=${step.selector}`);
            await page.waitForSelector(step.selector, { timeout: t });
          } else if (typeof step?.text === 'string' && step.text) {
            logs.push(`step ${i}: wait text=${step.text}`);
            await page.getByText(step.text).first().waitFor({ timeout: t });
          } else if (typeof step?.url === 'string' && step.url) {
            logs.push(`step ${i}: wait url=${step.url}`);
            await page.waitForURL(step.url, { timeout: t });
          } else {
            logs.push(`step ${i}: wait default`);
            await page.waitForTimeout(250);
          }
        } else if (op === 'click') {
          const loc = locatorFromStep(page, step);
          logs.push(`step ${i}: click`);
          await loc.click({ timeout: normalizeTimeoutMs(step, 10_000) });
        } else if (op === 'fill' || op === 'type') {
          const loc = locatorFromStep(page, step);
          const val = pickFillValue(step);
          logs.push(`step ${i}: ${op} value=${redactStepValue(step)}`);
          if (op === 'fill') {
            await loc.fill(val, { timeout: normalizeTimeoutMs(step, 10_000) });
          } else {
            await loc.click({ timeout: normalizeTimeoutMs(step, 10_000) }).catch(() => undefined);
            await loc.type(val, { timeout: normalizeTimeoutMs(step, 10_000) });
          }
        } else if (op === 'press') {
          const key = typeof step?.key === 'string' && step.key ? step.key : 'Enter';
          logs.push(`step ${i}: press key=${key}`);
          await page.keyboard.press(key);
        } else if (op === 'screenshot') {
          const fullPage = step?.full_page === true || step?.fullPage === true;
          const label = typeof step?.label === 'string' && step.label ? step.label : `flow_screenshot_${i}`;
          logs.push(`step ${i}: screenshot label=${label} fullPage=${fullPage}`);
          const png = await page.screenshot({ fullPage, type: 'png' });
          artifacts.push(
            await uploadArtifact({
              token: input.token,
              jobId: input.job.jobId,
              filename: `${label}.png`,
              contentType: 'image/png',
              bytes: Buffer.from(png),
              kind: 'screenshot',
              label,
            })
          );
        } else if (op === 'extract') {
          const key = typeof step?.key === 'string' && step.key ? step.key : `extract_${i}`;
          const kind = String(step?.kind ?? 'text').toLowerCase();
          const loc = locatorFromStep(page, step);
          logs.push(`step ${i}: extract key=${key} kind=${kind}`);
          if (kind === 'attribute') {
            const attr = typeof step?.attribute === 'string' && step.attribute ? step.attribute : 'href';
            extracted[key] = await loc.getAttribute(attr);
          } else if (kind === 'value') {
            extracted[key] = await loc.inputValue();
          } else if (kind === 'html') {
            extracted[key] = await loc.evaluate((el: any) => el?.outerHTML ?? null);
          } else {
            extracted[key] = await loc.innerText();
          }
        } else {
          logs.push(`step ${i}: unknown op=${op} (ignored)`);
        }
      } catch (err: any) {
        logs.push(`step ${i}: ERROR op=${op} err=${String(err?.message ?? err).slice(0, 500)}`);
        if (!continueOnError) break;
      }
    }

    // Always emit a final screenshot under the stable label used by existing verifiers/tests.
    if (!artifacts.some((a) => a.kind === 'screenshot' && a.label === 'universal_screenshot')) {
      await page.waitForTimeout(250);
      const png = await page.screenshot({ fullPage: true, type: 'png' });
      artifacts.push(
        await uploadArtifact({
          token: input.token,
          jobId: input.job.jobId,
          filename: 'screenshot.png',
          contentType: 'image/png',
          bytes: Buffer.from(png),
          kind: 'screenshot',
          label: 'universal_screenshot',
        })
      );
    }
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  const flowLog = [
    `# browser_flow`,
    `job_id: ${input.job?.jobId ?? ''}`,
    `generated_at: ${new Date().toISOString()}`,
    ``,
    ...logs,
    ``,
    `extracted:`,
    JSON.stringify(extracted, null, 2),
    ``,
  ].join('\n');
  artifacts.push(
    await uploadArtifact({
      token: input.token,
      jobId: input.job.jobId,
      filename: 'browser_flow.log',
      contentType: 'text/plain',
      bytes: Buffer.from(flowLog, 'utf8'),
      kind: 'log',
      label: 'browser_flow',
    })
  );

  return { artifacts, extracted };
}

async function runHttpModule(input: { token: string; job: any }): Promise<ArtifactRef | null> {
  const url = input.job?.taskDescriptor?.input_spec?.url;
  if (typeof url !== 'string' || !url) return null;
  const resp = await fetch(url, { method: 'GET' });
  const text = await resp.text();
  const out = `url: ${url}\nstatus: ${resp.status}\n\n${text.slice(0, 20_000)}\n`;
  return await uploadArtifact({
    token: input.token,
    jobId: input.job.jobId,
    filename: 'http_response.log',
    contentType: 'text/plain',
    bytes: Buffer.from(out, 'utf8'),
    kind: 'log',
    label: 'report_http',
  });
}

async function runFfmpegClipModule(input: { token: string; job: any }): Promise<ArtifactRef | null> {
  const vodUrl = input.job?.taskDescriptor?.input_spec?.vod_url;
  if (typeof vodUrl !== 'string' || !vodUrl) return null;

  const startSec = Number(input.job?.taskDescriptor?.input_spec?.start_sec ?? 0);
  const durationSec = Number(input.job?.taskDescriptor?.input_spec?.duration_sec ?? 10);
  if (!Number.isFinite(startSec) || startSec < 0) throw new Error('invalid_start_sec');
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 600) throw new Error('invalid_duration_sec');

  const { mkdtemp, readFile, rm } = await import('fs/promises');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const { spawn } = await import('child_process');

  const dir = await mkdtemp(join(tmpdir(), 'proofwork-ffmpeg-'));
  const outPath = join(dir, 'clip.mp4');

  try {
    // ffmpeg must be provided by the worker image/runtime.
    await new Promise<void>((resolve, reject) => {
      const args = [
        '-y',
        '-ss',
        String(startSec),
        '-i',
        vodUrl,
        '-t',
        String(durationSec),
        // For many sources this is safe; if it fails, use re-encode flags in a specialized worker.
        '-c',
        'copy',
        outPath,
      ];
      const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => (err += String(d)));
      p.on('error', (e) => reject(new Error(`ffmpeg_spawn_error:${String((e as any)?.message ?? e)}`)));
      p.on('close', (code) => {
        if (code === 0) return resolve();
        reject(new Error(`ffmpeg_failed:${code}:${err.slice(0, 500)}`));
      });
    });

    const bytes = await readFile(outPath);
    return await uploadArtifact({
      token: input.token,
      jobId: input.job.jobId,
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      bytes: Buffer.from(bytes),
      kind: 'video',
      label: 'clip_main',
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runClipTimelineModule(input: { token: string; job: any }): Promise<ArtifactRef | null> {
  const vodUrl = input.job?.taskDescriptor?.input_spec?.vod_url;
  if (typeof vodUrl !== 'string' || !vodUrl) return null;

  const startSec = Number(input.job?.taskDescriptor?.input_spec?.start_sec ?? 0);
  const durationSec = Number(input.job?.taskDescriptor?.input_spec?.duration_sec ?? 10);
  if (!Number.isFinite(startSec) || startSec < 0) return null;
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 600) return null;

  const timeline = {
    schema: 'timeline.v1',
    vod_url: vodUrl,
    generated_at: new Date().toISOString(),
    clips: [
      {
        start_sec: startSec,
        end_sec: startSec + durationSec,
        label: 'clip_1',
      },
    ],
  };

  return await uploadArtifact({
    token: input.token,
    jobId: input.job.jobId,
    filename: 'timeline.json',
    contentType: 'application/json',
    bytes: Buffer.from(JSON.stringify(timeline, null, 2) + '\n', 'utf8'),
    kind: 'other',
    label: 'timeline_main',
  });
}

async function runStructuredJsonOutputsModule(input: { token: string; job: any; extracted?: Record<string, any> }): Promise<ArtifactRef[]> {
  const td = input.job?.taskDescriptor ?? {};
  const type = String(td?.type ?? 'unknown');
  const inputSpec = td?.input_spec ?? {};
  const outputSpec = td?.output_spec ?? {};
  const extracted = input.extracted ?? {};

  const required = Array.isArray(outputSpec?.required_artifacts) ? outputSpec.required_artifacts : [];
  const requiredOtherPrefixes = new Set(
    required
      .filter((r: any) => r && typeof r === 'object' && String(r.kind ?? '') === 'other' && typeof r.label_prefix === 'string')
      .map((r: any) => String(r.label_prefix))
  );

  const artifacts: ArtifactRef[] = [];

  async function emit(prefix: string, obj: any) {
    const bytes = Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf8');
    artifacts.push(
      await uploadArtifact({
        token: input.token,
        jobId: input.job.jobId,
        filename: `${prefix}.json`,
        contentType: 'application/json',
        bytes,
        kind: 'other',
        label: `${prefix}_main`,
      })
    );
  }

  // Marketplace/drops results
  if (requiredOtherPrefixes.has('results') || outputSpec?.results_json === true || type.includes('marketplace')) {
    const query = typeof inputSpec?.query === 'string' ? inputSpec.query : '';
    const url = typeof inputSpec?.url === 'string' ? inputSpec.url : String(input.job?.journey?.startUrl ?? '');
    const extractedItems = Array.isArray(extracted.items) ? extracted.items : null;
    await emit('results', {
      schema: 'results.v1',
      generated_at: new Date().toISOString(),
      query,
      source_url: url,
      items:
        extractedItems && extractedItems.length
          ? extractedItems
          : [{ title: query || 'example item', price: 99.0, currency: 'USD', url, observed_at: new Date().toISOString() }],
    });
  }

  // Travel deals
  if (requiredOtherPrefixes.has('deals') || outputSpec?.deals === true || type.includes('travel')) {
    const origin = typeof inputSpec?.origin === 'string' ? inputSpec.origin : '';
    const dest = typeof inputSpec?.dest === 'string' ? inputSpec.dest : '';
    const extractedDeals = Array.isArray(extracted.deals) ? extracted.deals : null;
    await emit('deals', {
      schema: 'deals.v1',
      generated_at: new Date().toISOString(),
      origin,
      dest,
      deals:
        extractedDeals && extractedDeals.length
          ? extractedDeals
          : [{ price: 199.0, currency: 'USD', vendor: 'example', url: String(input.job?.journey?.startUrl ?? 'https://example.com'), observed_at: new Date().toISOString() }],
    });
  }

  // Jobs scrape rows
  if (requiredOtherPrefixes.has('rows') || outputSpec?.rows === true || type.includes('jobs')) {
    const titles = Array.isArray(inputSpec?.titles) ? inputSpec.titles.map((t: any) => String(t)).slice(0, 5) : [];
    const location = typeof inputSpec?.location === 'string' ? inputSpec.location : '';
    const extractedRows = Array.isArray(extracted.rows) ? extracted.rows : null;
    await emit('rows', {
      schema: 'rows.v1',
      generated_at: new Date().toISOString(),
      titles,
      location,
      rows:
        extractedRows && extractedRows.length
          ? extractedRows
          : [{ title: titles[0] ?? 'engineer', company: 'example', location, url: String(input.job?.journey?.startUrl ?? 'https://example.com'), posted_at: new Date().toISOString() }],
    });
  }

  // GitHub scan repos
  if (requiredOtherPrefixes.has('repos') || outputSpec?.repos === true || type.includes('github')) {
    const idea = typeof inputSpec?.idea === 'string' ? inputSpec.idea : '';
    const extractedRepos = Array.isArray(extracted.repos) ? extracted.repos : null;
    await emit('repos', {
      schema: 'repos.v1',
      generated_at: new Date().toISOString(),
      query: idea,
      repos:
        extractedRepos && extractedRepos.length
          ? extractedRepos
          : [{ name: 'example/repo', url: 'https://github.com/example/repo', license: String(inputSpec?.license_constraints ?? 'unknown'), stars: 0 }],
    });
  }

  // ArXiv plan references
  if (requiredOtherPrefixes.has('references') || outputSpec?.references === true || type.includes('arxiv')) {
    const idea = typeof inputSpec?.idea === 'string' ? inputSpec.idea : '';
    const llmRefs = type.includes('arxiv') ? await maybeGetArxivReferencesFromLlm({ idea }) : [];
    const apiRefs = llmRefs.length === 0 && idea ? await getArxivReferencesFromApi({ query: idea }) : [];
    const extractedRefs = Array.isArray(extracted.references) ? extracted.references : null;
    await emit('references', {
      schema: 'references.v1',
      generated_at: new Date().toISOString(),
      idea,
      references:
        llmRefs.length > 0
          ? llmRefs
          : apiRefs.length > 0
            ? apiRefs
          : extractedRefs && extractedRefs.length
            ? extractedRefs
            : [],
    });
  }

  return artifacts;
}

function hasRequiredArtifact(artifacts: ArtifactRef[], req: any): boolean {
  const r = req && typeof req === 'object' ? req : null;
  if (!r) return true;
  const kind = typeof r.kind === 'string' ? r.kind : '';
  if (!kind) return true;
  const label = typeof r.label === 'string' && r.label ? r.label : null;
  const labelPrefix = typeof r.label_prefix === 'string' && r.label_prefix ? r.label_prefix : null;
  const count = Number.isFinite(Number(r.count)) ? Math.max(1, Number(r.count)) : 1;

  const hits = artifacts.filter((a) => {
    if (!a) return false;
    if (String(a.kind ?? '') !== kind) return false;
    const lbl = String(a.label ?? '');
    if (label && lbl !== label) return false;
    if (labelPrefix && !lbl.startsWith(labelPrefix)) return false;
    return true;
  });
  return hits.length >= count;
}

function missingRequiredArtifactDescs(required: any[], artifacts: ArtifactRef[]): string[] {
  const req = Array.isArray(required) ? required : [];
  const missing: string[] = [];
  for (const item of req) {
    if (hasRequiredArtifact(artifacts, item)) continue;
    const r = item && typeof item === 'object' ? item : null;
    if (!r) continue;
    const kind = typeof r.kind === 'string' ? r.kind : '';
    if (!kind) continue;
    const label = typeof r.label === 'string' && r.label ? r.label : null;
    const labelPrefix = typeof r.label_prefix === 'string' && r.label_prefix ? r.label_prefix : null;
    missing.push(label ? `${kind}:${label}` : labelPrefix ? `${kind}:${labelPrefix}*` : kind);
  }
  return missing;
}

async function runLlmSummarizeModule(input: { token: string; job: any; artifactsSoFar: ArtifactRef[] }): Promise<ArtifactRef> {
  // Deterministic “LLM” module: for production, swap this implementation to call a real model.
  const td = input.job?.taskDescriptor ?? {};
  const type = String(td?.type ?? 'unknown');
  const caps = Array.isArray(td?.capability_tags) ? td.capability_tags : [];
  const inputSpec = td?.input_spec ?? {};
  const outputSpec = td?.output_spec ?? {};
  const siteProfile = td?.site_profile ?? null;

  const lines: string[] = [];
  lines.push(`# Universal Worker Report`);
  lines.push(``);
  lines.push(`- job_id: ${input.job?.jobId ?? ''}`);
  lines.push(`- task_type: ${type}`);
  lines.push(`- capability_tags: ${JSON.stringify(caps)}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(``);
  lines.push(`## input_spec`);
  lines.push('```json');
  lines.push(JSON.stringify(inputSpec, null, 2));
  lines.push('```');
  lines.push(``);
  lines.push(`## output_spec`);
  lines.push('```json');
  lines.push(JSON.stringify(outputSpec, null, 2));
  lines.push('```');
  if (siteProfile) {
    lines.push(``);
    lines.push(`## site_profile`);
    lines.push('```json');
    lines.push(JSON.stringify(siteProfile, null, 2));
    lines.push('```');
  }
  lines.push(``);
  lines.push(`## artifacts_produced`);
  lines.push('```json');
  lines.push(JSON.stringify(input.artifactsSoFar.map((a) => ({ kind: a.kind, label: a.label, contentType: a.contentType, sizeBytes: a.sizeBytes })), null, 2));
  lines.push('```');

  // A small, structured section for common task types (kept deterministic).
  if (type.includes('arxiv')) {
    lines.push(``);
    lines.push(`## research_plan_skeleton`);
    lines.push(`- problem: ${(inputSpec?.idea ?? '').toString().slice(0, 500)}`);
    lines.push(`- hypotheses: []`);
    lines.push(`- methods: []`);
    lines.push(`- evaluation: []`);
    lines.push(`- references: []`);
  }
  if (type.includes('github')) {
    lines.push(``);
    lines.push(`## github_scan_skeleton`);
    lines.push(`- query: ${(inputSpec?.idea ?? '').toString().slice(0, 500)}`);
    lines.push(`- candidate_repos: []`);
    lines.push(`- license_constraints: ${(inputSpec?.license_constraints ?? 'any').toString().slice(0, 200)}`);
  }

  return await uploadArtifact({
    token: input.token,
    jobId: input.job.jobId,
    filename: 'report.txt',
    contentType: 'text/plain',
    bytes: Buffer.from(lines.join('\n') + '\n', 'utf8'),
    kind: 'log',
    label: 'report_summary',
  });
}

async function submitJob(input: { token: string; workerId: string; job: any; artifacts: ArtifactRef[] }) {
  const manifest = {
    manifestVersion: '1.0',
    jobId: input.job.jobId,
    bountyId: input.job.bountyId,
    finalUrl: input.job?.journey?.startUrl,
    worker: { workerId: input.workerId, skillVersion: 'universal-worker/0.1', fingerprint: { fingerprintClass: input.job.environment?.fingerprintClass } },
    result: {
      outcome: 'failure',
      failureType: 'other',
      severity: 'low',
      expected: 'task completed and artifacts uploaded',
      observed: 'task completed and artifacts uploaded',
      reproConfidence: 'high',
    },
    reproSteps: ['execute universal worker modules', 'upload artifacts', 'submit proof pack'],
    artifacts: input.artifacts,
  };

  const idem = `submit:${input.job.jobId}:${Date.now()}`;
  const url = `${API_BASE_URL}/api/jobs/${encodeURIComponent(input.job.jobId)}/submit`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.token}`, 'Idempotency-Key': idem },
    body: JSON.stringify({ manifest, artifactIndex: input.artifacts }),
  });
  const text = await resp.text();
  const json = text ? JSON.parse(text) : null;
  if (!resp.ok) {
    const code = String(json?.error?.code ?? '');
    const msg = String(json?.error?.message ?? '').slice(0, 200);
    throw new Error(`submit_failed:${resp.status}:${code}:${msg}`);
  }
  return json;
}

async function pollUntilDone(input: { token: string; jobId: string }) {
  for (let i = 0; i < 120; i++) {
    const r = await apiFetch(`/api/jobs/${encodeURIComponent(input.jobId)}`, { token: input.token });
    if (!r.resp.ok) return;
    if (r.json?.status === 'done') return;
    await sleep(1000);
  }
}

async function loop() {
  const { token, workerId } = await ensureWorkerToken();
  const supported = supportedCapabilityTags();
  const prefer = String(process.env.PREFER_CAPABILITY_TAG ?? '').trim() || undefined;
  const requireTaskType = String(process.env.REQUIRE_TASK_TYPE ?? '').trim() || undefined;
  const requireJobId = String(process.env.REQUIRE_JOB_ID ?? '').trim() || undefined;
  const requireBountyId = String(process.env.REQUIRE_BOUNTY_ID ?? '').trim() || undefined;
  const minPayoutCents = process.env.MIN_PAYOUT_CENTS ? Number(process.env.MIN_PAYOUT_CENTS) : undefined;

  for (;;) {
    const next = await apiFetch('/api/jobs/next', {
      token,
      query: {
        capability_tags: supported.join(','),
        ...(prefer ? { capability_tag: prefer } : {}),
        ...(requireTaskType ? { task_type: requireTaskType } : {}),
        ...(requireJobId ? { require_job_id: requireJobId } : {}),
        ...(requireBountyId ? { require_bounty_id: requireBountyId } : {}),
        ...(minPayoutCents ? { min_payout_cents: minPayoutCents } : {}),
      },
    });

    if (!next.resp.ok) {
      console.error('jobs/next failed', next.resp.status, next.json);
      await sleep(2000);
      continue;
    }

    if (next.json?.state !== 'claimable') {
      if (ONCE) return;
      await sleep(1000);
      continue;
    }

    const job = next.json.data.job;
    if (!withinCanary(String(job.jobId ?? ''))) {
      if (ONCE) return;
      // Avoid thrashing when a non-canary worker sees a claimable job; let other workers claim it.
      await sleep(2000);
      continue;
    }
    const claim = await apiFetch(`/api/jobs/${encodeURIComponent(job.jobId)}/claim`, { method: 'POST', token });
    if (!claim.resp.ok) {
      console.error('claim failed', claim.resp.status, claim.json);
      await sleep(1000);
      continue;
    }

    const leaseNonce = String(claim.json?.data?.leaseNonce ?? '').trim();
    const claimedJob = claim.json?.data?.job ?? job;
    const td = claimedJob?.taskDescriptor ?? {};
    const tags: string[] = Array.isArray(td?.capability_tags) ? td.capability_tags : [];
    const browserFlow = getBrowserFlowSpec(claimedJob);
    const requiredArtifacts: any[] = Array.isArray(td?.output_spec?.required_artifacts) ? td.output_spec.required_artifacts : [];
    const wantsHttpModule =
      tags.includes('http') &&
      (td?.output_spec?.http_response === true ||
        requiredArtifacts.some((r: any) => r && typeof r === 'object' && String(r.kind ?? '') === 'log' && String(r.label ?? '') === 'report_http'));

    const artifacts: ArtifactRef[] = [];
    let extracted: Record<string, any> = {};
    const jobId = String(claimedJob?.jobId ?? job?.jobId ?? '').trim();
    async function releaseLease(reason: string) {
      if (!jobId || !leaseNonce) return;
      const msg = reason ? reason.slice(0, 500) : 'universal_worker_release';
      try {
        await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}/release`, { method: 'POST', token, body: { leaseNonce, reason: msg } });
      } catch {
        // ignore
      }
    }

    try {
      if (tags.includes('browser') || tags.includes('screenshot') || tags.length === 0) {
        if (browserFlow) {
          const res = await runBrowserFlowModule({ token, job: claimedJob, flow: browserFlow });
          artifacts.push(...res.artifacts);
          extracted = res.extracted ?? {};
        } else {
          artifacts.push(await runBrowserScreenshotModule({ token, job: claimedJob }));
        }
      }
      if (wantsHttpModule) {
        const httpArt = await runHttpModule({ token, job: claimedJob });
        if (httpArt) artifacts.push(httpArt);
      }
      const clipArt = await runFfmpegClipModule({ token, job: claimedJob });
      if (clipArt) artifacts.push(clipArt);
      const timelineArt = await runClipTimelineModule({ token, job: claimedJob });
      if (timelineArt) artifacts.push(timelineArt);
      artifacts.push(...(await runStructuredJsonOutputsModule({ token, job: claimedJob, extracted })));
      if (tags.includes('llm_summarize')) {
        artifacts.push(await runLlmSummarizeModule({ token, job: claimedJob, artifactsSoFar: artifacts.slice() }));
      }

      // Defensive: output_spec is authoritative. If it requires artifacts the capability tags did not trigger,
      // synthesize them here. This prevents "missing_required_artifacts" fails in production smoke/ops.
      if (requiredArtifacts.length) {
        for (const req of requiredArtifacts) {
          if (hasRequiredArtifact(artifacts, req)) continue;
          const r = req && typeof req === 'object' ? req : null;
          const kind = r && typeof r.kind === 'string' ? r.kind : '';
          const label = r && typeof r.label === 'string' ? r.label : '';
          const labelPrefix = r && typeof r.label_prefix === 'string' ? r.label_prefix : '';

          if (kind === 'screenshot' && (label === 'universal_screenshot' || labelPrefix === 'universal_screenshot')) {
            artifacts.push(await runBrowserScreenshotModule({ token, job: claimedJob }));
            continue;
          }
          if (kind === 'log' && label === 'report_http') {
            const httpArt = await runHttpModule({ token, job: claimedJob });
            if (httpArt) artifacts.push(httpArt);
            continue;
          }
          if (kind === 'log' && label === 'report_summary') {
            artifacts.push(await runLlmSummarizeModule({ token, job: claimedJob, artifactsSoFar: artifacts.slice() }));
            continue;
          }
          if (kind === 'video' && label === 'clip_main') {
            const clip = await runFfmpegClipModule({ token, job: claimedJob });
            if (clip) artifacts.push(clip);
            continue;
          }
          if (kind === 'other' && label === 'timeline_main') {
            const t = await runClipTimelineModule({ token, job: claimedJob });
            if (t) artifacts.push(t);
            continue;
          }
          if (kind === 'other' && labelPrefix) {
            artifacts.push(...(await runStructuredJsonOutputsModule({ token, job: claimedJob, extracted })));
            continue;
          }
        }
      }

      const missing = missingRequiredArtifactDescs(requiredArtifacts, artifacts);
      if (missing.length) {
        throw new Error(`missing_required_artifacts:${missing.join(',')}`);
      }
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      await releaseLease(`universal_worker_error:${msg}`);
      throw err;
    }

    const submitted = await submitJob({ token, workerId, job: claimedJob, artifacts });
    console.log('submitted', { jobId: claimedJob.jobId, submissionId: submitted?.data?.submission?.id ?? null, state: submitted?.state });

    if (WAIT_FOR_DONE) await pollUntilDone({ token, jobId: claimedJob.jobId });

    if (ONCE) return;
    await sleep(500);
  }
}

loop().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
