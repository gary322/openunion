// Deterministic verifier gateway service (Playwright harness + evidence artifacts).
// Load .env only when running as a standalone process (avoid polluting test runners that import this module).
const shouldLoadEnv =
  process.env.NODE_ENV !== 'test' && !process.env.VITEST && import.meta.url === `file://${process.argv[1]}`;
const _loadEnv = shouldLoadEnv ? import('dotenv/config').catch(() => {}) : Promise.resolve();
await _loadEnv;

import Fastify from 'fastify';
import { createHash } from 'crypto';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const API_BASE_URL = (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const VERIFIER_TOKEN = process.env.VERIFIER_TOKEN ?? 'pw_vf_internal';
const VERIFIER_MAX_ARTIFACT_BYTES = Number(process.env.VERIFIER_MAX_ARTIFACT_BYTES ?? 25_000_000);
const VERIFIER_ARTIFACT_DOWNLOAD_TIMEOUT_MS = Number(process.env.VERIFIER_ARTIFACT_DOWNLOAD_TIMEOUT_MS ?? 15_000);

function clamp01(x: number) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function score(input: { reproSteps?: any[]; artifacts?: any[]; expected?: string; observed?: string }) {
  const r = clamp01((input.reproSteps?.length ?? 0) >= 1 ? 1 : 0);
  const e = clamp01((input.artifacts?.length ?? 0) >= 1 ? 1 : 0);
  const a = clamp01((input.expected?.length ?? 0) >= 5 && (input.observed?.length ?? 0) >= 5 ? 1 : 0.5);
  const n = 1;
  const t = 1;
  const qualityScore = Math.round(((r + e + a + n + t) / 5) * 100);
  return { R: r, E: e, A: a, N: n, T: t, qualityScore };
}

function origin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function sha256Hex(buf: Buffer) {
  return createHash('sha256').update(buf).digest('hex');
}

function guessKind(filename: string): 'screenshot' | 'log' | 'other' {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'screenshot';
  if (lower.endsWith('.log') || lower.endsWith('.txt')) return 'log';
  return 'other';
}

function asObject(v: any): Record<string, any> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as any) : null;
}

function getTaskDescriptor(jobSpec: any): Record<string, any> | null {
  const td = asObject(jobSpec?.taskDescriptor);
  return td ? td : null;
}

function getCapabilityTags(td: Record<string, any> | null): string[] {
  const tags = td?.capability_tags;
  if (!Array.isArray(tags)) return [];
  return tags.filter((t) => typeof t === 'string');
}

function extractArtifactIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/api\/artifacts\/([^/]+)\/download$/);
    return m?.[1] ?? null;
  } catch {
    const m = url.match(/^\/api\/artifacts\/([^/]+)\/download$/);
    return m?.[1] ?? null;
  }
}

async function downloadArtifactBytes(artifactId: string): Promise<{ ok: true; bytes: Buffer; contentType: string | null } | { ok: false; error: string }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), VERIFIER_ARTIFACT_DOWNLOAD_TIMEOUT_MS);
  try {
    const resp = await fetch(`${API_BASE_URL}/api/artifacts/${artifactId}/download`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${VERIFIER_TOKEN}` },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!resp.ok) {
      return { ok: false, error: `artifact_download_failed:${resp.status}` };
    }

    const len = resp.headers.get('content-length');
    if (len && Number.isFinite(Number(len)) && Number(len) > VERIFIER_MAX_ARTIFACT_BYTES) {
      return { ok: false, error: 'artifact_too_large' };
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength > VERIFIER_MAX_ARTIFACT_BYTES) {
      return { ok: false, error: 'artifact_too_large' };
    }

    return { ok: true, bytes: buf, contentType: resp.headers.get('content-type') };
  } catch (err: any) {
    const msg = String(err?.name ?? '').includes('Abort') ? 'artifact_download_timeout' : String(err?.message ?? err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(t);
  }
}

function sniffMp4(bytes: Buffer): boolean {
  // Minimal MP4 container sniff (also used by the upload scanner): [size][ftyp] at offset 4.
  return bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
}

function parseJsonBytes(bytes: Buffer): any {
  const text = bytes.toString('utf8');
  return JSON.parse(text);
}

function ensureJsonArray(parsed: any, key: string, opts: { minItems?: number; itemKeys?: string[] } = {}): string | null {
  const arr = Array.isArray(parsed?.[key]) ? parsed[key] : null;
  if (!arr) return `json_missing_${key}`;
  const min = opts.minItems ?? 1;
  if (arr.length < min) return `json_${key}_too_small`;
  const itemKeys = Array.isArray(opts.itemKeys) ? opts.itemKeys : [];
  if (itemKeys.length) {
    for (const item of arr) {
      if (!item || typeof item !== 'object') return `json_${key}_item_not_object`;
      for (const k of itemKeys) {
        if (item[k] === undefined || item[k] === null || String(item[k]).length === 0) return `json_${key}_item_missing_${k}`;
      }
    }
  }
  return null;
}

async function validateDescriptorBoundArtifacts(input: {
  td: Record<string, any> | null;
  artifactIndex: any[];
}): Promise<{ ok: true } | { ok: false; verdict: 'fail' | 'inconclusive'; reason: string }> {
  const td = input.td;
  if (!td) return { ok: true };

  const outputSpec = asObject(td?.output_spec);
  const req = outputSpec ? outputSpec['required_artifacts'] : null;
  if (!Array.isArray(req) || req.length === 0) return { ok: true };

  const artifacts = Array.isArray(input.artifactIndex) ? input.artifactIndex : [];

  // If a descriptor requires a video artifact, validate that it is at least an MP4 container.
  const videoReqs = req.filter((r) => asObject(r)?.kind === 'video');
  for (const _r of videoReqs) {
    const r = asObject(_r)!;
    const labelPrefix = typeof r.label_prefix === 'string' ? r.label_prefix : null;
    const label = typeof r.label === 'string' ? r.label : null;
    const match = artifacts.find((a) => {
      if (!a || typeof a !== 'object') return false;
      if (String(a.kind ?? '') !== 'video') return false;
      const lbl = String(a.label ?? '');
      if (label && lbl !== label) return false;
      if (labelPrefix && !lbl.startsWith(labelPrefix)) return false;
      return true;
    });
    if (!match) continue; // missingRequiredArtifacts should have caught this.
    const artifactId = extractArtifactIdFromUrl(String(match.url ?? ''));
    if (!artifactId) return { ok: false, verdict: 'fail', reason: 'video_artifact_missing_internal_id' };

    const dl = await downloadArtifactBytes(artifactId);
    if (!dl.ok) return { ok: false, verdict: 'inconclusive', reason: dl.error };
    if (!sniffMp4(dl.bytes)) return { ok: false, verdict: 'fail', reason: 'video_artifact_invalid_mp4' };
  }

  // If a descriptor requires a timeline artifact, validate it is valid JSON with basic structure.
  const timelineReqs = req.filter((r) => {
    const o = asObject(r);
    if (!o) return false;
    if (String(o.kind ?? '') !== 'other') return false;
    const lp = typeof o.label_prefix === 'string' ? o.label_prefix : '';
    return lp.startsWith('timeline');
  });

  for (const _r of timelineReqs) {
    const r = asObject(_r)!;
    const labelPrefix = typeof r.label_prefix === 'string' ? r.label_prefix : null;
    const label = typeof r.label === 'string' ? r.label : null;
    const match = artifacts.find((a) => {
      if (!a || typeof a !== 'object') return false;
      if (String(a.kind ?? '') !== 'other') return false;
      const lbl = String(a.label ?? '');
      if (label && lbl !== label) return false;
      if (labelPrefix && !lbl.startsWith(labelPrefix)) return false;
      return true;
    });
    if (!match) continue;
    const artifactId = extractArtifactIdFromUrl(String(match.url ?? ''));
    if (!artifactId) return { ok: false, verdict: 'fail', reason: 'timeline_artifact_missing_internal_id' };

    const dl = await downloadArtifactBytes(artifactId);
    if (!dl.ok) return { ok: false, verdict: 'inconclusive', reason: dl.error };
    let parsed: any;
    try {
      parsed = parseJsonBytes(dl.bytes);
    } catch {
      return { ok: false, verdict: 'fail', reason: 'timeline_artifact_invalid_json' };
    }

    const clips = Array.isArray(parsed?.clips) ? parsed.clips : null;
    if (!clips || clips.length < 1) return { ok: false, verdict: 'fail', reason: 'timeline_artifact_missing_clips' };
    for (const c of clips) {
      const start = Number(c?.start_sec);
      const end = Number(c?.end_sec);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        return { ok: false, verdict: 'fail', reason: 'timeline_artifact_invalid_clip_bounds' };
      }
    }
  }

  // Generic structured JSON outputs (kind=other with known label_prefix).
  const jsonOtherReqs = req.filter((r) => {
    const o = asObject(r);
    if (!o) return false;
    if (String(o.kind ?? '') !== 'other') return false;
    const lp = typeof o.label_prefix === 'string' ? o.label_prefix : '';
    return ['results', 'deals', 'rows', 'repos', 'references'].includes(lp);
  });

  for (const _r of jsonOtherReqs) {
    const r = asObject(_r)!;
    const labelPrefix = typeof r.label_prefix === 'string' ? r.label_prefix : null;
    if (!labelPrefix) continue;

    const match = artifacts.find((a) => {
      if (!a || typeof a !== 'object') return false;
      if (String(a.kind ?? '') !== 'other') return false;
      const lbl = String(a.label ?? '');
      if (!lbl.startsWith(labelPrefix)) return false;
      return true;
    });
    if (!match) continue;

    const artifactId = extractArtifactIdFromUrl(String(match.url ?? ''));
    if (!artifactId) return { ok: false, verdict: 'fail', reason: `${labelPrefix}_artifact_missing_internal_id` };

    const dl = await downloadArtifactBytes(artifactId);
    if (!dl.ok) return { ok: false, verdict: 'inconclusive', reason: dl.error };

    let parsed: any;
    try {
      parsed = parseJsonBytes(dl.bytes);
    } catch {
      return { ok: false, verdict: 'fail', reason: `${labelPrefix}_artifact_invalid_json` };
    }

    if (labelPrefix === 'results') {
      const err = ensureJsonArray(parsed, 'items', { minItems: 1, itemKeys: ['url'] });
      if (err) return { ok: false, verdict: 'fail', reason: `results_artifact_${err}` };
    } else if (labelPrefix === 'deals') {
      const err = ensureJsonArray(parsed, 'deals', { minItems: 1, itemKeys: ['url'] });
      if (err) return { ok: false, verdict: 'fail', reason: `deals_artifact_${err}` };
    } else if (labelPrefix === 'rows') {
      const err = ensureJsonArray(parsed, 'rows', { minItems: 1, itemKeys: ['title', 'url'] });
      if (err) return { ok: false, verdict: 'fail', reason: `rows_artifact_${err}` };
    } else if (labelPrefix === 'repos') {
      const err = ensureJsonArray(parsed, 'repos', { minItems: 1, itemKeys: ['name', 'url', 'license'] });
      if (err) return { ok: false, verdict: 'fail', reason: `repos_artifact_${err}` };
    } else if (labelPrefix === 'references') {
      const err = ensureJsonArray(parsed, 'references', { minItems: 1, itemKeys: ['id', 'url'] });
      if (err) return { ok: false, verdict: 'fail', reason: `references_artifact_${err}` };
    }
  }

  return { ok: true };
}

// If a descriptor specifies required outputs, enforce them deterministically before running any expensive harness.
// Convention (optional): task_descriptor.output_spec.required_artifacts = [{ kind, label_prefix?, label?, count? }]
function missingRequiredArtifacts(td: Record<string, any> | null, artifactIndex: any[]): string[] {
  const outputSpec = asObject(td?.output_spec);
  const req = outputSpec ? outputSpec['required_artifacts'] : null;
  if (!Array.isArray(req) || req.length === 0) return [];

  const artifacts = Array.isArray(artifactIndex) ? artifactIndex : [];
  const missing: string[] = [];

  for (const item of req) {
    const r = asObject(item);
    if (!r) continue;
    const kind = typeof r.kind === 'string' ? r.kind : null;
    if (!kind) continue;
    const labelPrefix = typeof r.label_prefix === 'string' ? r.label_prefix : null;
    const label = typeof r.label === 'string' ? r.label : null;
    const count = Number.isFinite(Number(r.count)) ? Math.max(1, Number(r.count)) : 1;

    const hits = artifacts.filter((a) => {
      if (!a || typeof a !== 'object') return false;
      if (String(a.kind ?? '') !== kind) return false;
      const lbl = String(a.label ?? '');
      if (label && lbl !== label) return false;
      if (labelPrefix && !lbl.startsWith(labelPrefix)) return false;
      return true;
    });

    if (hits.length < count) {
      const desc = label ? `${kind}:${label}` : labelPrefix ? `${kind}:${labelPrefix}*` : kind;
      missing.push(desc);
    }
  }

  return missing;
}

async function presignEvidence(input: {
  submissionId: string;
  files: Array<{ filename: string; contentType: string; sizeBytes: number }>;
}): Promise<{ uploads: Array<{ artifactId: string; url: string; headers: Record<string, string>; finalUrl: string; filename: string }> }> {
  const resp = await fetch(`${API_BASE_URL}/api/verifier/uploads/presign`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${VERIFIER_TOKEN}`,
    },
    body: JSON.stringify(input),
  });
  if (!resp.ok) throw new Error(`evidence_presign_failed:${resp.status}`);
  return (await resp.json()) as any;
}

async function completeEvidence(input: { artifactId: string; sha256: string; sizeBytes: number }) {
  const resp = await fetch(`${API_BASE_URL}/api/verifier/uploads/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${VERIFIER_TOKEN}`,
    },
    body: JSON.stringify(input),
  });
  if (!resp.ok) throw new Error(`evidence_complete_failed:${resp.status}`);
}

async function uploadEvidenceArtifacts(input: {
  submissionId: string;
  files: Array<{ filename: string; contentType: string; bytes: Buffer; label: string }>;
}): Promise<any[]> {
  const presigned = await presignEvidence({
    submissionId: input.submissionId,
    files: input.files.map((f) => ({ filename: f.filename, contentType: f.contentType, sizeBytes: f.bytes.byteLength })),
  });

  const refs: any[] = [];

  for (const f of input.files) {
    const u = presigned.uploads.find((x: any) => x.filename === f.filename);
    if (!u) throw new Error(`missing_presign_for:${f.filename}`);

    const putHeaders: Record<string, string> = { ...(u.headers ?? {}) };
    // Local upload endpoints are authenticated; presigned S3 URLs are not.
    if (typeof u.url === 'string' && (u.url.includes('/api/verifier/uploads/local/') || u.url.startsWith(`${API_BASE_URL}/`))) {
      putHeaders['Authorization'] = `Bearer ${VERIFIER_TOKEN}`;
    }

    const put = await fetch(u.url, { method: 'PUT', headers: putHeaders, body: f.bytes as any });
    if (!put.ok) throw new Error(`evidence_put_failed:${put.status}`);

    const sha = sha256Hex(f.bytes);
    await completeEvidence({ artifactId: u.artifactId, sha256: sha, sizeBytes: f.bytes.byteLength });

    refs.push({
      kind: guessKind(f.filename),
      label: f.label,
      sha256: sha,
      url: u.finalUrl,
      sizeBytes: f.bytes.byteLength,
      contentType: f.contentType,
    });
  }

  return refs;
}

async function runPlaywrightHarness(input: {
  url: string;
  allowedOrigins: string[];
  timeoutMs: number;
}): Promise<{
  ok: boolean;
  finalUrl?: string;
  screenshotPng?: Buffer;
  har?: Buffer;
  consoleLog?: Buffer;
  blockedRequests: number;
  error?: string;
}> {
  const allowed = new Set((input.allowedOrigins ?? []).filter((x) => typeof x === 'string' && x.length > 0));

  const dir = await mkdtemp(join(tmpdir(), 'proofwork-verifier-'));
  const harPath = join(dir, 'network.har');

  let blockedRequests = 0;
  const consoleLines: string[] = [];

  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      locale: 'en-US',
      timezoneId: 'UTC',
      userAgent: 'proofwork-verifier/0.1 (chromium)',
      recordHar: { path: harPath, content: 'embed' },
    });

    await context.route('**/*', async (route) => {
      const u = route.request().url();
      if (u.startsWith('data:') || u.startsWith('about:') || u.startsWith('blob:')) {
        return route.continue();
      }
      try {
        const o = new URL(u).origin;
        if (allowed.size === 0 || allowed.has(o)) return route.continue();
      } catch {
        // fallthrough
      }
      blockedRequests += 1;
      return route.abort();
    });

    const page = await context.newPage();
    page.on('console', (msg) => consoleLines.push(`[console:${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => consoleLines.push(`[pageerror] ${String((err as any)?.message ?? err)}`));
    page.on('requestfailed', (req) => consoleLines.push(`[requestfailed] ${req.url()} ${(req.failure() as any)?.errorText ?? ''}`));

    await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: input.timeoutMs });
    await page.waitForTimeout(250);

    const screenshotPng = await page.screenshot({ fullPage: true, type: 'png' });
    const finalUrl = page.url();

    await context.close();
    await browser.close();

    const har = await readFile(harPath).catch(() => undefined);
    const consoleLog = Buffer.from(consoleLines.join('\n') + '\n', 'utf8');

    return { ok: true, finalUrl, screenshotPng: Buffer.from(screenshotPng), har: har ? Buffer.from(har) : undefined, consoleLog, blockedRequests };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err), blockedRequests };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const app = Fastify({ logger: process.env.NODE_ENV !== 'test' && !process.env.VITEST });

app.get('/health', async () => ({ ok: true }));

// POST body is whatever src/verification/gateway.ts sends.
app.post('/run', async (request, _reply) => {
  const body = request.body as any;
  const jobSpec = body?.jobSpec;
  const submission = body?.submission;

  const descriptor = getTaskDescriptor(jobSpec);
  const capabilityTags = getCapabilityTags(descriptor);

  const allowedOrigins: string[] = jobSpec?.constraints?.allowedOrigins ?? [];
  const finalUrl = submission?.manifest?.finalUrl;
  const finalOrigin = typeof finalUrl === 'string' ? origin(finalUrl) : null;

  const s = score({
    reproSteps: submission?.manifest?.reproSteps,
    artifacts: submission?.artifactIndex,
    expected: submission?.manifest?.result?.expected,
    observed: submission?.manifest?.result?.observed,
  });

  if (finalOrigin && allowedOrigins.length && !allowedOrigins.includes(finalOrigin)) {
    return {
      verdict: 'fail',
      reason: 'finalUrl origin not allowed',
      scorecard: s,
      evidenceArtifacts: submission?.artifactIndex ?? [],
      runMetadata: { engine: 'playwright', finalOrigin, blocked: true },
    };
  }

  const hasObserved = typeof submission?.manifest?.result?.observed === 'string' && submission.manifest.result.observed.length >= 5;
  const hasExpected = typeof submission?.manifest?.result?.expected === 'string' && submission.manifest.result.expected.length >= 5;
  const hasRepro = Array.isArray(submission?.manifest?.reproSteps) && submission.manifest.reproSteps.length >= 1;
  const hasArtifacts = Array.isArray(submission?.artifactIndex) && submission.artifactIndex.length >= 1;

  let verdict: 'pass' | 'fail' | 'inconclusive' = hasObserved && hasExpected && hasRepro && hasArtifacts ? 'pass' : 'inconclusive';
  let reason = verdict === 'pass' ? 'manifest + artifacts look complete' : 'insufficient evidence to deterministically verify';

  const evidence: any[] = Array.isArray(submission?.artifactIndex) ? submission.artifactIndex.slice() : [];

  const missing = missingRequiredArtifacts(descriptor, submission?.artifactIndex ?? []);
  if (missing.length) {
    return {
      verdict: 'fail',
      reason: `missing_required_artifacts:${missing.join(',')}`,
      scorecard: s,
      evidenceArtifacts: evidence,
      runMetadata: { engine: 'policy', taskType: descriptor?.type ?? 'unknown' },
    };
  }

  const contentCheck = await validateDescriptorBoundArtifacts({ td: descriptor, artifactIndex: submission?.artifactIndex ?? [] });
  if (!contentCheck.ok) {
    return {
      verdict: contentCheck.verdict,
      reason: contentCheck.reason,
      scorecard: s,
      evidenceArtifacts: evidence,
      runMetadata: { engine: 'policy', taskType: descriptor?.type ?? 'unknown', adapter: 'descriptor_content' },
    };
  }

  // Playwright harness evidence
  // Only run the browser harness when the task actually declares it can use the browser, or when no descriptor is provided.
  if (typeof finalUrl === 'string' && (descriptor === null || capabilityTags.length === 0 || capabilityTags.includes('browser'))) {
    const run = await runPlaywrightHarness({
      url: finalUrl,
      allowedOrigins,
      timeoutMs: Number(process.env.VERIFIER_PLAYWRIGHT_TIMEOUT_MS ?? 15_000),
    });

    const meta: any = {
      engine: 'playwright',
      finalOrigin,
      blockedRequests: run.blockedRequests,
      harnessOk: run.ok,
    };

    if (!run.ok) {
      verdict = 'inconclusive';
      reason = `playwright_failed:${run.error ?? 'unknown'}`;
      return { verdict, reason, scorecard: s, evidenceArtifacts: evidence, runMetadata: meta };
    }

    try {
      const files: Array<{ filename: string; contentType: string; bytes: Buffer; label: string }> = [];
      if (run.screenshotPng) {
        files.push({
          filename: `verifier_${submission?.submissionId ?? 'sub'}_attempt${body?.attemptNo ?? 1}.png`,
          contentType: 'image/png',
          bytes: run.screenshotPng,
          label: 'verifier_screenshot',
        });
      }
      if (run.consoleLog) {
        files.push({
          filename: `verifier_${submission?.submissionId ?? 'sub'}_attempt${body?.attemptNo ?? 1}.log`,
          contentType: 'text/plain',
          bytes: run.consoleLog,
          label: 'verifier_console',
        });
      }
      if (run.har) {
        files.push({
          filename: `verifier_${submission?.submissionId ?? 'sub'}_attempt${body?.attemptNo ?? 1}.har`,
          contentType: 'application/octet-stream',
          bytes: run.har,
          label: 'verifier_har',
        });
      }

      if (files.length && typeof body?.submissionId === 'string') {
        const uploaded = await uploadEvidenceArtifacts({ submissionId: body.submissionId, files });
        evidence.push(...uploaded);
      }
    } catch (err: any) {
      // Evidence upload failures should not block the verdict path.
      meta.evidenceUploadError = String(err?.message ?? err);
    }

    meta.harnessFinalUrl = run.finalUrl;
    return { verdict, reason, scorecard: s, evidenceArtifacts: evidence, runMetadata: meta };
  }

  const engine =
    typeof finalUrl === 'string' && (descriptor === null || capabilityTags.length === 0 || capabilityTags.includes('browser'))
      ? 'playwright'
      : 'policy';
  return {
    verdict,
    reason,
    scorecard: s,
    evidenceArtifacts: evidence,
    runMetadata: { engine, finalOrigin, harnessOk: false, taskType: descriptor?.type ?? 'unknown' },
  };
});

export function buildVerifierGateway() {
  return app;
}

const port = Number(process.env.VERIFIER_GATEWAY_PORT ?? 4010);
const host = process.env.VERIFIER_GATEWAY_HOST ?? '0.0.0.0';

if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen({ port, host }).then(() => {
    console.log(`verifier-gateway listening on ${host}:${port}`);
  });
}
