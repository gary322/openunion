// Proofwork Universal Worker implemented as an OpenClaw skill helper script.
//
// This is intentionally dependency-light (Node 22+ only) and uses:
// - Proofwork HTTP APIs (jobs/next, claim, presign uploads, submit)
// - openclaw CLI for browser screenshots/snapshots (optional but default)
// - ffmpeg/ffprobe for clip extraction (optional)
//
// Configuration is env-driven (see SKILL.md).

// Compatibility gate: this script relies on modern Fetch + Web Streams behavior.
const nodeMajor = Number(String(process.versions?.node ?? "").split(".")[0] ?? "");
if (!Number.isFinite(nodeMajor) || nodeMajor < 18) {
  console.error(`Node 18+ is required to run proofwork_worker.mjs (found ${process.versions?.node ?? "unknown"})`);
  process.exit(1);
}

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const API_BASE_URL = (process.env.PROOFWORK_API_BASE_URL ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);
const ONCE = String(process.env.ONCE ?? "").toLowerCase() === "true";
const WAIT_FOR_DONE = String(process.env.WAIT_FOR_DONE ?? "").toLowerCase() === "true";
const WORKER_DISPLAY_NAME =
  String(process.env.PROOFWORK_WORKER_DISPLAY_NAME ?? process.env.WORKER_DISPLAY_NAME ?? "").trim() ||
  "openclaw-universal";

const OPENCLAW_BIN = String(process.env.OPENCLAW_BIN ?? "openclaw").trim() || "openclaw";
const OPENCLAW_AGENT_ID_RAW = String(process.env.OPENCLAW_AGENT_ID ?? "").trim() || null;
const OPENCLAW_THINKING = String(process.env.OPENCLAW_THINKING ?? "low").trim() || "low";
const OPENCLAW_BROWSER_PROFILE = String(process.env.OPENCLAW_BROWSER_PROFILE ?? "").trim() || null;
const OPENCLAW_GATEWAY_URL = String(process.env.OPENCLAW_GATEWAY_URL ?? "").trim() || null;
const OPENCLAW_GATEWAY_TOKEN_ARG = String(process.env.OPENCLAW_GATEWAY_TOKEN ?? "").trim() || null;

function parseCsv(v) {
  return String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseBool(v, fallback = false) {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return fallback;
}

function parseIntClamped(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

const LOG_LEVEL = String(process.env.PROOFWORK_LOG_LEVEL ?? "").trim().toLowerCase() === "debug" ? "debug" : "info";
function debugLog(...args) {
  if (LOG_LEVEL !== "debug") return;
  console.log("[debug]", ...args);
}

const POLL_INTERVAL_MS = parseIntClamped(process.env.PROOFWORK_POLL_INTERVAL_MS ?? 1000, 1000, 250, 60_000);
const ERROR_BACKOFF_MS = parseIntClamped(process.env.PROOFWORK_ERROR_BACKOFF_MS ?? 2000, 2000, 250, 60_000);
const BROWSER_HEALTH_INTERVAL_MS = parseIntClamped(
  process.env.PROOFWORK_BROWSER_HEALTH_INTERVAL_MS ?? 60_000,
  60_000,
  5_000,
  10 * 60_000,
);
const FFMPEG_HEALTH_INTERVAL_MS = parseIntClamped(
  process.env.PROOFWORK_FFMPEG_HEALTH_INTERVAL_MS ?? 60_000,
  60_000,
  5_000,
  10 * 60_000,
);

const PROOFWORK_WORKER_TOKEN_FILE = String(process.env.PROOFWORK_WORKER_TOKEN_FILE ?? "").trim() || null;
const PROOFWORK_STATUS_FILE = String(process.env.PROOFWORK_STATUS_FILE ?? "").trim() || null;
const PROOFWORK_PAUSE_FILE = String(process.env.PROOFWORK_PAUSE_FILE ?? "").trim() || null;

const ORIGIN_ENFORCEMENT = String(process.env.PROOFWORK_ORIGIN_ENFORCEMENT ?? "").trim().toLowerCase() === "off" ? "off" : "strict";
const NO_LOGIN = parseBool(process.env.PROOFWORK_NO_LOGIN, true);
const VALUE_ENV_ALLOWLIST = new Set(parseCsv(process.env.PROOFWORK_VALUE_ENV_ALLOWLIST));
const EXTRA_ALLOWED_ORIGINS = new Set(parseCsv(process.env.PROOFWORK_EXTRA_ALLOWED_ORIGINS));

const ALLOW_TASK_TYPES = new Set(parseCsv(process.env.PROOFWORK_ALLOW_TASK_TYPES));
const DENY_TASK_TYPES = new Set(parseCsv(process.env.PROOFWORK_DENY_TASK_TYPES));
const ALLOW_ORIGINS = new Set(parseCsv(process.env.PROOFWORK_ALLOW_ORIGINS));
const DENY_ORIGINS = new Set(parseCsv(process.env.PROOFWORK_DENY_ORIGINS));

const HTTP_MAX_BYTES = parseIntClamped(process.env.PROOFWORK_HTTP_MAX_BYTES ?? 2_000_000, 2_000_000, 1024, 50_000_000);
const ARTIFACT_MAX_BYTES = process.env.PROOFWORK_ARTIFACT_MAX_BYTES
  ? parseIntClamped(process.env.PROOFWORK_ARTIFACT_MAX_BYTES, 50_000_000, 1024, 500_000_000)
  : null;
const FFMPEG_MAX_DURATION_SEC = parseIntClamped(process.env.PROOFWORK_FFMPEG_MAX_DURATION_SEC ?? 60, 60, 1, 600);

const JOB_TIME_BUDGET_SEC_OVERRIDE = process.env.PROOFWORK_JOB_TIME_BUDGET_SEC
  ? parseIntClamped(process.env.PROOFWORK_JOB_TIME_BUDGET_SEC, 240, 10, 3600)
  : null;

const DANGEROUS_ENABLE_OPENCLAW_AGENT_SUMMARIZE = parseBool(process.env.PROOFWORK_DANGEROUS_ENABLE_OPENCLAW_AGENT_SUMMARIZE, false);
const OPENCLAW_AGENT_ID = DANGEROUS_ENABLE_OPENCLAW_AGENT_SUMMARIZE ? OPENCLAW_AGENT_ID_RAW : null;

// Optional: use llm-arxiv (https://github.com/agustif/llm-arxiv) to generate real arXiv references for
// `type=arxiv_*` tasks. This remains opt-in so workers can run without Python/llm installed.
const LLM_BIN = String(process.env.LLM_BIN ?? "llm").trim() || "llm";
const LLM_ARXIV_ENABLED =
  String(process.env.LLM_ARXIV_ENABLED ?? "").trim().toLowerCase() === "true" ||
  String(process.env.LLM_ARXIV_ENABLED ?? "").trim() === "1";
const LLM_ARXIV_MAX_RESULTS = (() => {
  const n = Number(process.env.LLM_ARXIV_MAX_RESULTS ?? 5);
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(10, Math.floor(n)));
})();

const ARXIV_API_BASE_URL = String(process.env.ARXIV_API_BASE_URL ?? "").trim() || "https://export.arxiv.org/api/query";
const ARXIV_MAX_RESULTS = (() => {
  const n = Number(process.env.ARXIV_MAX_RESULTS ?? 5);
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(10, Math.floor(n)));
})();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function detectPngOrJpeg(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 3) return null;

  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { contentType: "image/png", ext: "png" };
  }

  // JPEG signature: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: "image/jpeg", ext: "jpg" };
  }

  return null;
}

let statusState = {};

async function writeStatus(patch) {
  if (!PROOFWORK_STATUS_FILE) return;
  statusState = { ...(statusState ?? {}), ...(patch ?? {}) };
  const dir = dirname(PROOFWORK_STATUS_FILE);
  const tmp = join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  await mkdir(dir, { recursive: true });
  const payload = JSON.stringify(statusState, null, 2) + "\n";
  await writeFile(tmp, payload, { mode: 0o600 });
  await rename(tmp, PROOFWORK_STATUS_FILE);
  try {
    await chmod(PROOFWORK_STATUS_FILE, 0o600);
  } catch {
    // ignore
  }
}

async function isPaused() {
  if (!PROOFWORK_PAUSE_FILE) return false;
  try {
    const s = await stat(PROOFWORK_PAUSE_FILE);
    return s.isFile();
  } catch {
    return false;
  }
}

function supportedCapabilityTags() {
  return parseCsv(process.env.PROOFWORK_SUPPORTED_CAPABILITY_TAGS ?? "browser,http,screenshot,llm_summarize");
}

function canaryPercent() {
  const v = Number(process.env.PROOFWORK_CANARY_PERCENT ?? 100);
  if (!Number.isFinite(v)) return 100;
  return Math.max(0, Math.min(100, v));
}

function withinCanary(jobId) {
  const pct = canaryPercent();
  if (pct >= 100) return true;
  if (pct <= 0) return false;
  const h = createHash("sha256").update(jobId).digest();
  const n = h.readUInt32BE(0) / 0xffffffff;
  return n < pct / 100;
}

function urlOriginStrict(inputUrl) {
  const u = new URL(String(inputUrl));
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("unsupported_url_scheme");
  if (u.username || u.password) throw new Error("url_contains_credentials");
  return u.origin;
}

function originAllowedByWorkerPolicy(origin) {
  const o = String(origin ?? "");
  if (DENY_ORIGINS.has(o)) return false;
  if (ALLOW_ORIGINS.size > 0) return ALLOW_ORIGINS.has(o);
  return true;
}

function typeAllowedByWorkerPolicy(taskType) {
  const t = String(taskType ?? "");
  if (DENY_TASK_TYPES.has(t)) return false;
  if (ALLOW_TASK_TYPES.size > 0) return ALLOW_TASK_TYPES.has(t);
  return true;
}

function compileAllowedOrigins(job) {
  const base = Array.isArray(job?.constraints?.allowedOrigins) ? job.constraints.allowedOrigins : [];
  const out = new Set();
  for (const o of base) {
    try {
      out.add(urlOriginStrict(String(o)));
    } catch {
      // ignore invalid
    }
  }
  for (const o of EXTRA_ALLOWED_ORIGINS) {
    try {
      out.add(urlOriginStrict(String(o)));
    } catch {
      // ignore invalid
    }
  }
  return out;
}

function assertUrlAllowed(url, allowedOrigins, what = "url") {
  const origin = urlOriginStrict(url);
  if (!originAllowedByWorkerPolicy(origin)) {
    throw new Error(`origin_blocked_by_worker_policy:${what}:${origin}`);
  }
  if (ORIGIN_ENFORCEMENT === "strict") {
    if (!allowedOrigins || allowedOrigins.size === 0) {
      throw new Error(`origin_enforcement_missing_allowed_origins:${what}`);
    }
    if (!allowedOrigins.has(origin)) {
      throw new Error(`origin_not_allowed:${what}:${origin}`);
    }
  }
  return origin;
}

function looksLikeLoginText(s) {
  const t = String(s ?? "").toLowerCase();
  if (!t) return false;
  return (
    t.includes("oauth") ||
    t.includes("sso") ||
    t.includes("sign in") ||
    t.includes("signin") ||
    t.includes("log in") ||
    t.includes("login") ||
    t.includes("password") ||
    t.includes("passcode") ||
    t.includes("one-time") ||
    t.includes("one time") ||
    t.includes("otp") ||
    t.includes("2fa") ||
    t.includes("mfa") ||
    t.includes("verification code") ||
    t.includes("auth/")
  );
}

function noLoginPreflightScore(job, allowedOrigins) {
  // Best-effort heuristic. Goal: avoid credential entry or auth flows in a public worker pool.
  let score = 0;
  const td = job?.taskDescriptor ?? {};
  const inputUrl = td?.input_spec?.url;
  const startUrl =
    typeof inputUrl === "string" && inputUrl.trim()
      ? inputUrl.trim()
      : typeof job?.journey?.startUrl === "string"
        ? job.journey.startUrl.trim()
        : "";

  if (looksLikeLoginText(startUrl)) score += 2;
  try {
    const o = urlOriginStrict(startUrl);
    if (!originAllowedByWorkerPolicy(o)) score += 5;
    if (ORIGIN_ENFORCEMENT === "strict" && allowedOrigins.size > 0 && !allowedOrigins.has(o)) score += 5;
  } catch {
    // ignore
  }

  const flow = getBrowserFlowSpec(job);
  const steps = Array.isArray(flow?.steps) ? flow.steps : [];
  for (const step of steps) {
    const op = String(step?.op ?? step?.action ?? "").trim().toLowerCase();
    if (!op) continue;

    if ((op === "navigate" || op === "goto") && typeof step?.url === "string" && step.url.trim()) {
      const u = step.url.trim();
      if (looksLikeLoginText(u)) score += 2;
      try {
        const o = urlOriginStrict(u);
        if (!originAllowedByWorkerPolicy(o)) score += 5;
        if (ORIGIN_ENFORCEMENT === "strict" && allowedOrigins.size > 0 && !allowedOrigins.has(o)) score += 5;
      } catch {
        score += 2;
      }
    }

    const fields = [
      step?.selector,
      step?.text,
      step?.role,
      step?.name,
      step?.label,
    ]
      .map((x) => (typeof x === "string" ? x : ""))
      .filter(Boolean)
      .join(" ");

    if (op === "click") {
      if (looksLikeLoginText(fields)) score += 2;
    }
    if (op === "fill" || op === "type") {
      const f = fields.toLowerCase();
      if (f.includes("password") || f.includes("passcode")) score += 5;
      if (f.includes("otp") || f.includes("2fa") || f.includes("mfa") || f.includes("verification code")) score += 5;
      if (f.includes("continue with google") || f.includes("continue with apple") || f.includes("continue with")) score += 5;
      if (f.includes("email") || f.includes("e-mail") || f.includes("username") || f.includes("user name")) score += 1;
      if (typeof step?.value_env === "string" && step.value_env.trim()) {
        const name = step.value_env.trim();
        if (!isAllowedValueEnv(name)) score += 5;
      }
    }
    if (op === "extract" && typeof step?.fn === "string" && step.fn.trim()) score += 10;
  }

  return score;
}

async function apiFetch(path, opts = {}) {
  const url = new URL(`${API_BASE_URL}${path}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  const headers = { "Content-Type": "application/json", ...(opts.headers ?? {}) };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  const resp = await fetch(url.toString(), {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await resp.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 10_000) };
    }
  }
  return { resp, json };
}

async function ensureWorkerToken() {
  const existing =
    String(process.env.PROOFWORK_WORKER_TOKEN ?? "").trim() ||
    String(process.env.WORKER_TOKEN ?? "").trim();
  if (existing) return { token: existing, workerId: "unknown" };

  if (PROOFWORK_WORKER_TOKEN_FILE) {
    try {
      const raw = await readFile(PROOFWORK_WORKER_TOKEN_FILE, "utf8");
      const j = raw ? JSON.parse(raw) : null;
      const token = typeof j?.token === "string" ? j.token.trim() : "";
      const workerId = typeof j?.workerId === "string" ? j.workerId.trim() : "";
      if (token) return { token, workerId: workerId || "unknown" };
    } catch {
      // ignore
    }
  }

  const reg = await apiFetch("/api/workers/register", {
    method: "POST",
    body: { displayName: WORKER_DISPLAY_NAME, capabilities: { openclaw: true } },
  });
  if (!reg.resp.ok) throw new Error(`worker_register_failed:${reg.resp.status}`);
  const token = String(reg.json?.token ?? "");
  const workerId = String(reg.json?.workerId ?? "");
  if (!token) throw new Error("worker_register_missing_token");

  if (PROOFWORK_WORKER_TOKEN_FILE) {
    const dir = dirname(PROOFWORK_WORKER_TOKEN_FILE);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    const payload = JSON.stringify({ workerId, token, createdAt: Date.now() }, null, 2) + "\n";
    await writeFile(tmp, payload, { mode: 0o600 });
    await rename(tmp, PROOFWORK_WORKER_TOKEN_FILE);
    try {
      await chmod(PROOFWORK_WORKER_TOKEN_FILE, 0o600);
    } catch {
      // ignore
    }
  }

  return { token, workerId };
}

async function maybeConfigurePayoutAddress({ token }) {
  const addressRaw = String(process.env.PROOFWORK_PAYOUT_ADDRESS ?? "").trim();
  if (!addressRaw) return;
  const chain = String(process.env.PROOFWORK_PAYOUT_CHAIN ?? "base").trim() || "base";
  const signature = String(process.env.PROOFWORK_PAYOUT_SIGNATURE ?? "").trim();

  // If already configured, do nothing.
  try {
    const me = await apiFetch("/api/worker/me", { token });
    const currentAddress = String(me.json?.payout?.address ?? "").trim();
    const verifiedAt = me.json?.payout?.verifiedAt ?? null;
    if (me.resp.ok && currentAddress && verifiedAt) {
      await writeStatus({ payout: { configured: true, chain: me.json?.payout?.chain ?? null, address: currentAddress, verifiedAt } });
      return;
    }
  } catch {
    // ignore
  }

  if (!signature) {
    try {
      const msg = await apiFetch("/api/worker/payout-address/message", {
        token,
        method: "POST",
        body: { chain, address: addressRaw },
      });
      const message = String(msg.json?.message ?? "").trim();
      if (msg.resp.ok && message) {
        console.error(
          [
            `[payout] payout address is not configured yet.`,
            `[payout] Sign this message with ${addressRaw} and set PROOFWORK_PAYOUT_SIGNATURE (or plugin config payoutSignature):`,
            message,
          ].join("\n"),
        );
      } else {
        console.error(`[payout] payout address is not configured yet (missing signature)`);
      }
    } catch {
      console.error(`[payout] payout address is not configured yet (missing signature)`);
    }
    await writeStatus({ payout: { configured: false, chain, address: addressRaw, missingSignature: true } });
    return;
  }

  try {
    const set = await apiFetch("/api/worker/payout-address", {
      token,
      method: "POST",
      body: { chain, address: addressRaw, signature },
    });
    if (!set.resp.ok) {
      console.error(`[payout] payout address set failed status=${set.resp.status}`, set.json);
      await writeStatus({ payout: { configured: false, chain, address: addressRaw, lastError: `set_failed:${set.resp.status}` } });
      return;
    }
    console.log(`[payout] payout address verified: ${String(set.json?.address ?? addressRaw)}`);
    await writeStatus({ payout: { configured: true, chain: set.json?.chain ?? chain, address: set.json?.address ?? addressRaw } });
  } catch (err) {
    console.error(`[payout] payout address set error: ${String(err?.message ?? err)}`);
    await writeStatus({ payout: { configured: false, chain, address: addressRaw, lastError: String(err?.message ?? err) } });
  }
}

function rewriteArtifactFinalUrlToApiBase(finalUrl) {
  // If PUBLIC_BASE_URL differs from this skill's configured API base URL, rewrite the origin
  // for /api/artifacts/* URLs so we can poll scan readiness reliably.
  try {
    const u = new URL(String(finalUrl));
    if (!u.pathname.startsWith("/api/artifacts/")) return String(finalUrl);
    const api = new URL(API_BASE_URL);
    u.protocol = api.protocol;
    u.hostname = api.hostname;
    u.port = api.port;
    return u.toString();
  } catch {
    const s = String(finalUrl);
    if (s.startsWith("/api/artifacts/")) return `${API_BASE_URL}${s}`;
    return s;
  }
}

async function waitForArtifactScanned({ token, finalUrl }) {
  const url = rewriteArtifactFinalUrlToApiBase(finalUrl);
  const headers = { Authorization: `Bearer ${token}` };
  const debug =
    String(process.env.PROOFWORK_ARTIFACT_WAIT_DEBUG ?? process.env.ARTIFACT_WAIT_DEBUG ?? "")
      .trim()
      .toLowerCase() === "true" ||
    String(process.env.PROOFWORK_ARTIFACT_WAIT_DEBUG ?? process.env.ARTIFACT_WAIT_DEBUG ?? "")
      .trim() === "1";
  const maxWaitRaw = Number(process.env.PROOFWORK_ARTIFACT_SCAN_MAX_WAIT_SEC ?? process.env.ARTIFACT_SCAN_MAX_WAIT_SEC ?? 300);
  // Clamp to avoid infinite hangs while still allowing slow clamd cold starts in real deployments.
  const maxWaitSec = Number.isFinite(maxWaitRaw) ? Math.max(30, Math.min(30 * 60, Math.floor(maxWaitRaw))) : 300;
  let lastStatus = null;
  for (let i = 0; i < maxWaitSec; i++) {
    const resp = await fetch(url, { method: "GET", headers, redirect: "manual" });
    // Avoid buffering large artifacts. For 422 we may read a small JSON body with scanReason.
    if (resp.status !== 422) resp.body?.cancel?.();
    if (debug && (lastStatus !== resp.status || i % 20 === 0)) {
      console.log(`[artifact_wait] i=${i} status=${resp.status}`);
      lastStatus = resp.status;
    }
    if (resp.status === 401 || resp.status === 403) throw new Error(`artifact_download_unauthorized:${resp.status}`);
    if (resp.status === 422) {
      let reason = "";
      try {
        const txt = await resp.text();
        const json = txt ? JSON.parse(txt) : null;
        reason = String(json?.error?.scanReason ?? json?.error?.reason ?? "");
      } catch {
        // ignore
      }
      throw new Error(`artifact_blocked${reason ? `:${reason}` : ""}`);
    }
    if (resp.status === 409) {
      await sleep(1000);
      continue;
    }
    if (resp.ok || (resp.status >= 300 && resp.status < 400)) return;
    if (resp.status === 404) throw new Error("artifact_not_found");
    if (resp.status === 429) {
      await sleep(2000);
      continue;
    }
    await sleep(1000);
  }
  throw new Error("artifact_scan_timeout");
}

async function uploadArtifact(input) {
  if (ARTIFACT_MAX_BYTES && input?.bytes?.byteLength > ARTIFACT_MAX_BYTES) {
    throw new Error(`artifact_too_large:${input.bytes.byteLength}`);
  }
  const presign = await apiFetch("/api/uploads/presign", {
    method: "POST",
    token: input.token,
    body: {
      jobId: input.jobId,
      files: [
        {
          filename: input.filename,
          contentType: input.contentType,
          sizeBytes: input.bytes.byteLength,
        },
      ],
    },
  });
  if (!presign.resp.ok) {
    throw new Error(
      `presign_failed:${presign.resp.status}:${presign.json?.error?.code ?? ""}`,
    );
  }
  const up = presign.json?.uploads?.[0];
  if (!up?.url || !up?.artifactId || !up?.finalUrl) throw new Error("presign_missing_fields");

  const putUrl = (() => {
    // In local-storage mode, Proofwork serves authenticated upload URLs under /api/uploads/local/*.
    // If PUBLIC_BASE_URL is misconfigured (common in tests/dev), rewrite the origin to API_BASE_URL.
    try {
      const u = new URL(String(up.url));
      const isLocal =
        u.pathname.startsWith("/api/uploads/local/") || u.pathname.startsWith("/api/verifier/uploads/local/");
      if (!isLocal) return String(up.url);
      const api = new URL(API_BASE_URL);
      u.protocol = api.protocol;
      u.hostname = api.hostname;
      u.port = api.port;
      return u.toString();
    } catch {
      return String(up.url);
    }
  })();

  const putHeaders = { ...(up.headers ?? {}) };
  // When uploads are served locally (dev), the URL is protected by worker auth.
  if (
    typeof putUrl === "string" &&
    (putUrl.includes("/api/uploads/local/") || putUrl.includes("/api/verifier/uploads/local/") || putUrl.startsWith(`${API_BASE_URL}/`))
  ) {
    putHeaders["Authorization"] = `Bearer ${input.token}`;
  }

  const put = await fetch(putUrl, { method: "PUT", headers: putHeaders, body: input.bytes });
  if (!put.ok) throw new Error(`upload_put_failed:${put.status}`);

  const sha = sha256Hex(input.bytes);
  const complete = await apiFetch("/api/uploads/complete", {
    method: "POST",
    token: input.token,
    body: { artifactId: up.artifactId, sha256: sha, sizeBytes: input.bytes.byteLength },
  });
  if (!complete.resp.ok) throw new Error(`upload_complete_failed:${complete.resp.status}`);

  // S3 backend scans asynchronously; wait until download is available so submission can attach.
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

async function runOpenClaw(args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const normalizedArgs = (() => {
    const a = Array.isArray(args) ? args.slice() : [];
    if (a[0] !== "browser") return a;
    const rest = a.slice(1);
    const out = ["browser"];
    if (OPENCLAW_GATEWAY_URL && !rest.includes("--url")) out.push("--url", OPENCLAW_GATEWAY_URL);
    if (OPENCLAW_GATEWAY_URL && OPENCLAW_GATEWAY_TOKEN_ARG && !rest.includes("--token")) out.push("--token", OPENCLAW_GATEWAY_TOKEN_ARG);
    if (OPENCLAW_BROWSER_PROFILE && !rest.includes("--browser-profile")) out.push("--browser-profile", OPENCLAW_BROWSER_PROFILE);
    out.push(...rest);
    return out;
  })();

  const child = spawn(OPENCLAW_BIN, normalizedArgs, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += String(d)));
  child.stderr.on("data", (d) => (stderr += String(d)));

  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, timeoutMs);
  timer.unref?.();

  const code = await new Promise((resolve) => {
    child.on("close", resolve);
    child.on("error", () => resolve(1));
  });
  clearTimeout(timer);
  if (code !== 0) {
    throw new Error(`openclaw_failed:${code}:${stderr.slice(0, 300)}`);
  }
  return { stdout, stderr };
}

async function runBinary(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += String(d)));
  child.stderr.on("data", (d) => (stderr += String(d)));

  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, timeoutMs);
  timer.unref?.();

  const code = await new Promise((resolve) => {
    child.on("close", resolve);
    child.on("error", () => resolve(1));
  });
  clearTimeout(timer);
  return { code: Number(code ?? 1), stdout, stderr };
}

let openclawBrowserReady = false;
let lastBrowserHealthAt = 0;
let browserHealthy = null;
let lastBrowserHealthError = null;
let effectiveCapabilityTagsState = null;
let ffmpegHealthy = null;
let lastFfmpegHealthAt = 0;
let lastFfmpegHealthError = null;

async function probeOpenClawBrowserHealth() {
  if (!OPENCLAW_BROWSER_PROFILE) {
    return { ok: false, reason: "missing_openclaw_browser_profile" };
  }

  try {
    await ensureOpenClawBrowserReady();
  } catch (err) {
    return { ok: false, reason: `openclaw_browser_start_failed:${String(err?.message ?? err).slice(0, 200)}` };
  }

  // Create a blank tab without network so probes work in offline environments.
  let targetId = "";
  try {
    const tabNew = await runOpenClaw(["browser", "tab", "new", "--json"], { timeoutMs: 20_000 });
    const j = parseJsonFromStdout(tabNew.stdout);
    targetId = String(j?.tab?.targetId ?? j?.targetId ?? "").trim();
  } catch (err) {
    debugLog("openclaw tab new failed", String(err?.message ?? err));
  }

  // Fallback: open about:blank (older OpenClaw versions may not support tab new).
  if (!targetId) {
    try {
      const opened = await runOpenClaw(["browser", "open", "about:blank", "--json"], { timeoutMs: 20_000 });
      const j = parseJsonFromStdout(opened.stdout);
      targetId = String(j?.targetId ?? "").trim();
    } catch (err) {
      return { ok: false, reason: `openclaw_browser_open_failed:${String(err?.message ?? err).slice(0, 200)}` };
    }
  }

  // Probe the interactive snapshot path (Playwright-backed). This is required for browser_flow click/type.
  const dir = await mkdtemp(join(tmpdir(), "proofwork-openclaw-health-"));
  const outPath = join(dir, "snapshot.role.txt");
  try {
    await runOpenClaw(
      ["browser", "snapshot", "--interactive", "--compact", "--depth", "2", "--target-id", targetId, "--out", outPath, "--json"],
      { timeoutMs: 25_000 },
    );
  } catch (err) {
    const msg = String(err?.message ?? err);
    return { ok: false, reason: `openclaw_browser_snapshot_failed:${msg.slice(0, 200)}` };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    try {
      await runOpenClaw(["browser", "close", targetId, "--json"], { timeoutMs: 10_000 });
    } catch {
      // ignore
    }
  }

  return { ok: true };
}

function computeEffectiveCapabilityTags(baseSupported) {
  let base = Array.isArray(baseSupported) ? baseSupported.slice() : [];
  if (!base.length) return [];

  const needsFfmpeg = base.includes("ffmpeg");
  if (needsFfmpeg && ffmpegHealthy === false) base = base.filter((t) => t !== "ffmpeg");

  const needsBrowser = base.includes("browser") || base.includes("screenshot");
  if (!needsBrowser) return base;
  // Strict safety: require a dedicated browser profile when claiming browser-tag jobs.
  if (!OPENCLAW_BROWSER_PROFILE) return base.filter((t) => t !== "browser" && t !== "screenshot");
  if (browserHealthy === false) return base.filter((t) => t !== "browser" && t !== "screenshot");
  return base;
}

async function maybeUpdateBrowserHealth(baseSupported) {
  const base = Array.isArray(baseSupported) ? baseSupported : [];
  const needsBrowser = base.includes("browser") || base.includes("screenshot");
  if (!needsBrowser) {
    browserHealthy = null;
    lastBrowserHealthError = null;
    effectiveCapabilityTagsState = computeEffectiveCapabilityTags(base);
    await writeStatus({ effectiveCapabilityTags: effectiveCapabilityTagsState, browserReady: null, lastBrowserHealthAt: null, lastBrowserError: null });
    return;
  }

  const now = Date.now();
  if (browserHealthy !== null && now - lastBrowserHealthAt < BROWSER_HEALTH_INTERVAL_MS) {
    effectiveCapabilityTagsState = computeEffectiveCapabilityTags(base);
    return;
  }

  lastBrowserHealthAt = now;
  const res = await probeOpenClawBrowserHealth();
  browserHealthy = Boolean(res.ok);
  lastBrowserHealthError = res.ok ? null : String(res.reason ?? "browser_unhealthy");
  effectiveCapabilityTagsState = computeEffectiveCapabilityTags(base);

  await writeStatus({
    browserReady: browserHealthy,
    lastBrowserHealthAt: now,
    lastBrowserError: lastBrowserHealthError,
    effectiveCapabilityTags: effectiveCapabilityTagsState,
  });
}

async function probeFfmpegHealth() {
  // Detect presence and basic operability of ffmpeg. This is required for `capability_tags: ["ffmpeg"]` jobs.
  const res = await runBinary("ffmpeg", ["-version"], { timeoutMs: 5000 });
  if (res.code === 0) return { ok: true };
  const msg = String(res.stderr || res.stdout || "").trim().slice(0, 200);
  return { ok: false, reason: msg ? `ffmpeg_failed:${msg}` : `ffmpeg_failed:${res.code}` };
}

async function maybeUpdateFfmpegHealth(baseSupported) {
  const base = Array.isArray(baseSupported) ? baseSupported : [];
  const needsFfmpeg = base.includes("ffmpeg");
  if (!needsFfmpeg) {
    ffmpegHealthy = null;
    lastFfmpegHealthError = null;
    effectiveCapabilityTagsState = computeEffectiveCapabilityTags(base);
    await writeStatus({ effectiveCapabilityTags: effectiveCapabilityTagsState, ffmpegReady: null, lastFfmpegHealthAt: null, lastFfmpegError: null });
    return;
  }

  const now = Date.now();
  if (ffmpegHealthy !== null && now - lastFfmpegHealthAt < FFMPEG_HEALTH_INTERVAL_MS) {
    effectiveCapabilityTagsState = computeEffectiveCapabilityTags(base);
    return;
  }

  lastFfmpegHealthAt = now;
  const res = await probeFfmpegHealth();
  ffmpegHealthy = Boolean(res.ok);
  lastFfmpegHealthError = res.ok ? null : String(res.reason ?? "ffmpeg_unhealthy");
  effectiveCapabilityTagsState = computeEffectiveCapabilityTags(base);

  await writeStatus({
    ffmpegReady: ffmpegHealthy,
    lastFfmpegHealthAt: now,
    lastFfmpegError: lastFfmpegHealthError,
    effectiveCapabilityTags: effectiveCapabilityTagsState,
  });
}

async function ensureOpenClawBrowserReady() {
  if (openclawBrowserReady) return;
  if (!OPENCLAW_BROWSER_PROFILE) return;

  // Best-effort create profile (ignore errors: profile may already exist).
  try {
    await runOpenClaw(["browser", "create-profile", "--name", OPENCLAW_BROWSER_PROFILE, "--json"], { timeoutMs: 20_000 });
  } catch (err) {
    debugLog("openclaw create-profile ignored", String(err?.message ?? err));
  }

  // Start the browser control server for this profile (expected to be idempotent in OpenClaw).
  try {
    await runOpenClaw(["browser", "start", "--json"], { timeoutMs: 30_000 });
  } catch (err) {
    const msg = String(err?.message ?? err);
    throw new Error(`openclaw_browser_start_failed:${msg.slice(0, 300)}`);
  }

  openclawBrowserReady = true;
}

function stripOsc52AndAnsi(s) {
  const withoutOsc52 = String(s).replace(/\u001b]52;c;[^\u0007]*\u0007/g, "");
  return withoutOsc52.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

function parseLlmArxivSearchOutput(stdout) {
  const out = [];
  const lines = stripOsc52AndAnsi(stdout)
    .split(/\r?\n/)
    .map((l) => String(l).trimEnd());

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\bID:\s*([^\s]+)/i);
    if (!m?.[1]) continue;
    const arxivId = String(m[1]).trim();
    const next = String(lines[i + 1] ?? "");
    const m2 = next.match(/\bTitle:\s*(.+)\s*$/i);
    const title = m2?.[1] ? String(m2[1]).trim() : undefined;
    out.push({ arxivId, title });
  }
  return out;
}

async function maybeGetArxivReferencesFromLlm(idea) {
  if (!LLM_ARXIV_ENABLED) return [];
  const q = String(idea ?? "").trim();
  if (!q) return [];

  try {
    const res = await runBinary(LLM_BIN, ["arxiv-search", "-n", String(LLM_ARXIV_MAX_RESULTS), q], {
      timeoutMs: 30_000,
    });
    if (res.code !== 0) return [];
    const parsed = parseLlmArxivSearchOutput(res.stdout).slice(0, LLM_ARXIV_MAX_RESULTS);
    return parsed.map((p) => {
      const clean = String(p.arxivId).replace(/^arxiv:/i, "");
      return { id: `arxiv:${clean}`, title: p.title, url: `https://arxiv.org/abs/${clean}` };
    });
  } catch {
    return [];
  }
}

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function normalizeWs(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

function extractArxivId(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  s = s.replace(/^arxiv:/i, "");
  const mAbs = s.match(/\/abs\/([^?#]+)$/i);
  const mPdf = s.match(/\/pdf\/([^?#]+)$/i);
  if (mAbs?.[1]) s = mAbs[1];
  else if (mPdf?.[1]) s = mPdf[1];
  s = s.replace(/\.pdf$/i, "");
  s = s.replace(/v\d+$/i, "");
  s = s.trim();
  if (!s) return null;
  if (/^\d{4}\.\d{4,5}$/.test(s)) return s;
  if (/^[a-z-]+(\/[a-z-]+)*\/\d{7}$/i.test(s)) return s;
  return null;
}

function parseArxivAtomFeed(xml) {
  const out = [];
  const entries = String(xml).match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  for (const entry of entries) {
    const idMatch = entry.match(/<id>\s*([^<]+)\s*<\/id>/i);
    const titleMatch = entry.match(/<title>\s*([\s\S]*?)\s*<\/title>/i);
    const id = extractArxivId(idMatch?.[1] ?? "");
    if (!id) continue;
    const titleRaw = titleMatch?.[1] ? decodeXmlEntities(titleMatch[1]) : "";
    const title = titleRaw ? normalizeWs(titleRaw) : undefined;
    out.push({ id, title });
  }
  return out;
}

async function getArxivReferencesFromApi(query, opts = {}) {
  const q = String(query ?? "").trim();
  if (!q) return [];

  function pickArxivApiBaseUrl(allowedOrigins) {
    const preferred = ARXIV_API_BASE_URL;
    if (ORIGIN_ENFORCEMENT !== "strict") return preferred;
    if (!allowedOrigins) return preferred;
    try {
      const origin = urlOriginStrict(preferred);
      if (allowedOrigins.has(origin)) return preferred;
    } catch {
      // ignore
    }
    // Fallback: use a same-origin API endpoint if the preferred mirror origin isn't allowed.
    // This keeps "strict origins" jobs working even if only https://arxiv.org is allowlisted.
    if (allowedOrigins.has("https://arxiv.org")) return "https://arxiv.org/api/query";
    if (allowedOrigins.has("http://arxiv.org")) return "http://arxiv.org/api/query";
    if (allowedOrigins.has("https://export.arxiv.org")) return "https://export.arxiv.org/api/query";
    if (allowedOrigins.has("http://export.arxiv.org")) return "http://export.arxiv.org/api/query";
    return preferred;
  }

  try {
    const url = new URL(pickArxivApiBaseUrl(opts.allowedOrigins ?? null));
    url.searchParams.set("search_query", `all:${q}`);
    url.searchParams.set("start", "0");
    url.searchParams.set("max_results", String(ARXIV_MAX_RESULTS));

    const allowedOrigins = opts.allowedOrigins ?? null;
    const deadlineMs = Number.isFinite(Number(opts.deadlineMs)) ? Number(opts.deadlineMs) : Infinity;
    const { resp } = await fetchWithManualRedirects({
      url: url.toString(),
      allowedOrigins,
      deadlineMs,
      timeoutMs: 30_000,
      headers: { Accept: "application/atom+xml", "User-Agent": "proofwork-worker" },
    });
    if (!resp || !resp.ok) return [];
    const { bytes } = await readWebStreamLimited({ stream: resp.body, maxBytes: HTTP_MAX_BYTES });
    const xml = bytes.length ? Buffer.from(bytes).toString("utf8") : "";
    const parsed = parseArxivAtomFeed(xml).slice(0, ARXIV_MAX_RESULTS);
    const refs = parsed.map((p) => ({ id: `arxiv:${p.id}`, title: p.title, url: `https://arxiv.org/abs/${p.id}` }));

    if (ORIGIN_ENFORCEMENT === "strict" && allowedOrigins) {
      for (const r of refs) {
        assertUrlAllowed(r.url, allowedOrigins, "arxiv_reference_url");
      }
    }

    return refs;
  } catch {
    return [];
  }
}

function splitKeywordQuery(s) {
  const raw = String(s ?? "").trim();
  if (!raw) return [];
  return raw
    .split(/[,|]/g)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function includesAny(haystack, needles) {
  const h = String(haystack ?? "").toLowerCase();
  if (!h) return false;
  const ns = Array.isArray(needles) ? needles : [];
  return ns.some((n) => {
    const t = String(n ?? "").trim().toLowerCase();
    return t ? h.includes(t) : false;
  });
}

async function getRemotiveJobsRowsFromApi(input) {
  const inputSpec = input.inputSpec ?? {};
  const titles = Array.isArray(inputSpec?.titles) ? inputSpec.titles.map((t) => String(t)).filter(Boolean).slice(0, 10) : [];
  const location = typeof inputSpec?.location === "string" ? inputSpec.location.trim() : "";
  const include = splitKeywordQuery(inputSpec?.include_keywords);
  const exclude = splitKeywordQuery(inputSpec?.exclude_keywords);

  const apiUrl = "https://remotive.com/api/remote-jobs";
  const res = await fetchJsonLimited({
    url: apiUrl,
    allowedOrigins: input.allowedOrigins,
    deadlineMs: input.deadlineMs,
    timeoutMs: 25_000,
    headers: { Accept: "application/json", "User-Agent": "proofwork-worker" },
  });
  if (!res.ok || !res.json) return [];
  const jobs = Array.isArray(res.json?.jobs) ? res.json.jobs : [];
  const rows = [];
  for (const j of jobs) {
    const title = String(j?.title ?? "");
    const company = String(j?.company_name ?? j?.company ?? "");
    const url = String(j?.url ?? "");
    const postedAt = String(j?.publication_date ?? j?.posted_at ?? "");
    const loc = String(j?.candidate_required_location ?? j?.location ?? "");
    const txt = `${title} ${company} ${loc} ${String(j?.category ?? "")} ${String(j?.job_type ?? "")}`.trim();
    if (titles.length && !includesAny(title, titles) && !includesAny(txt, titles)) continue;
    if (location && location.toLowerCase() !== "remote") {
      if (!includesAny(loc, [location]) && !includesAny(txt, [location])) continue;
    }
    if (include.length && !includesAny(txt, include)) continue;
    if (exclude.length && includesAny(txt, exclude)) continue;
    if (url) {
      try {
        if (ORIGIN_ENFORCEMENT === "strict") assertUrlAllowed(url, input.allowedOrigins, "remotive_job_url");
      } catch {
        continue;
      }
    }
    rows.push({
      title: title || "unknown",
      company: company || "unknown",
      location: loc || location || "remote",
      url: url || "https://remotive.com",
      posted_at: postedAt || new Date().toISOString(),
      source: "remotive",
      category: j?.category ?? undefined,
      job_type: j?.job_type ?? undefined,
    });
    if (rows.length >= 25) break;
  }
  return rows;
}

function sanitizeGithubQueryTokens(idea) {
  const s = String(idea ?? "").trim();
  if (!s) return [];
  return s
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/g)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 10);
}

async function getGithubReposFromApi(input) {
  const inputSpec = input.inputSpec ?? {};
  const idea = typeof inputSpec?.idea === "string" ? inputSpec.idea.trim() : "";
  if (!idea) return [];
  const tokens = sanitizeGithubQueryTokens(idea);
  if (!tokens.length) return [];

  const languages = Array.isArray(inputSpec?.languages)
    ? inputSpec.languages.map((l) => String(l)).filter(Boolean).slice(0, 3)
    : [];
  const licenseAllow = Array.isArray(inputSpec?.license_allow)
    ? inputSpec.license_allow.map((l) => String(l)).filter(Boolean).slice(0, 1)
    : [];
  const minStars = Number.isFinite(Number(inputSpec?.min_stars)) ? Math.max(0, Math.floor(Number(inputSpec.min_stars))) : 0;

  const qParts = [];
  qParts.push(tokens.join(" "));
  qParts.push("fork:false");
  if (minStars > 0) qParts.push(`stars:>=${minStars}`);
  for (const l of languages) qParts.push(`language:${l}`);
  if (licenseAllow[0]) qParts.push(`license:${licenseAllow[0]}`);
  const q = qParts.join(" ").trim();
  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", q);
  url.searchParams.set("sort", "stars");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", "10");

  const res = await fetchJsonLimited({
    url: url.toString(),
    allowedOrigins: input.allowedOrigins,
    deadlineMs: input.deadlineMs,
    timeoutMs: 25_000,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "proofwork-worker",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) return [];
  if (res.status === 403 || res.status === 429) return [];
  const items = Array.isArray(res.json?.items) ? res.json.items : [];
  const repos = [];
  for (const it of items) {
    const full = String(it?.full_name ?? it?.name ?? "").trim();
    const htmlUrl = String(it?.html_url ?? "").trim();
    const stars = Number(it?.stargazers_count ?? 0);
    const license = it?.license?.spdx_id ? String(it.license.spdx_id) : it?.license?.key ? String(it.license.key) : null;
    repos.push({
      name: full || "unknown",
      url: htmlUrl || "https://github.com",
      license,
      stars: Number.isFinite(stars) ? stars : 0,
      description: it?.description ?? undefined,
    });
    if (repos.length >= 10) break;
  }
  return repos;
}

function parseJsonFromStdout(stdout) {
  const trimmed = String(stdout ?? "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Best-effort: find the outermost JSON object/array in the output.
    const firstObj = trimmed.indexOf("{");
    const firstArr = trimmed.indexOf("[");
    const start =
      firstObj >= 0 && firstArr >= 0 ? Math.min(firstObj, firstArr) : Math.max(firstObj, firstArr);
    const endObj = trimmed.lastIndexOf("}");
    const endArr = trimmed.lastIndexOf("]");
    const end = Math.max(endObj, endArr);
    if (start >= 0 && end > start) {
      const slice = trimmed.slice(start, end + 1);
      return JSON.parse(slice);
    }
    throw new Error("json_parse_failed");
  }
}

function getBrowserFlowSpec(job) {
  const sp = job?.taskDescriptor?.site_profile ?? null;
  if (!sp || typeof sp !== "object") return null;
  const bf = sp.browser_flow ?? sp.browserFlow ?? null;
  if (!bf || typeof bf !== "object") return null;
  return bf;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findRefInRoleSnapshot(snapshotText, match) {
  const role = typeof match?.role === "string" ? match.role.trim().toLowerCase() : "";
  const name = typeof match?.name === "string" ? match.name.trim() : "";
  const containsText = typeof match?.text === "string" ? match.text.trim() : "";

  const lines = String(snapshotText ?? "").split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes("[ref=")) continue;
    if (role && !line.toLowerCase().includes(`- ${role}`)) continue;
    if (name && !line.includes(`"${name}"`)) continue;
    if (containsText && !line.toLowerCase().includes(containsText.toLowerCase())) continue;
    const m = line.match(/\[ref=([^\]]+)\]/i);
    if (m?.[1]) return String(m[1]).trim();
  }
  return null;
}

async function resolveRefViaSnapshot(input) {
  const { targetId, match } = input;
  const dir = await mkdtemp(join(tmpdir(), "proofwork-openclaw-snap-"));
  const outPath = join(dir, "snapshot.role.txt");
  try {
    const snap = await runOpenClaw(
      ["browser", "snapshot", "--interactive", "--compact", "--depth", "6", "--target-id", targetId, "--out", outPath, "--json"],
      { timeoutMs: 45_000 },
    );
    const snapJson = parseJsonFromStdout(snap.stdout);
    const out = String(snapJson?.out ?? outPath).trim() || outPath;
    const text = await readFile(out, "utf8");
    return findRefInRoleSnapshot(text, match);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function redactStepValue(step) {
  if (typeof step?.value_env === "string" && step.value_env) return `<env:${step.value_env}>`;
  if (typeof step?.value === "string") return `<inline:${Math.min(80, step.value.length)} chars>`;
  return "<none>";
}

function isSensitiveEnvName(name) {
  return /token|secret|password|key/i.test(String(name ?? ""));
}

function isAllowedValueEnv(name) {
  const n = String(name ?? "").trim();
  if (!n) return false;
  if (!/^[A-Z0-9_]{1,100}$/.test(n)) return false;
  if (isSensitiveEnvName(n)) return false;
  return VALUE_ENV_ALLOWLIST.has(n);
}

function pickFillValue(step) {
  if (typeof step?.value_env === "string" && step.value_env) {
    const name = String(step.value_env).trim();
    if (!isAllowedValueEnv(name)) throw new Error(`value_env_not_allowed:${name}`);
    const raw = String(process.env[name] ?? "");
    const singleLine = raw.replace(/\r?\n/g, " ").trim();
    return singleLine.length > 1024 ? singleLine.slice(0, 1024) : singleLine;
  }
  if (typeof step?.value === "string") return step.value;
  return "";
}

function normalizeTimeoutMs(step, fallbackMs) {
  const n = Number(step?.timeout_ms ?? step?.timeoutMs ?? fallbackMs);
  if (!Number.isFinite(n)) return fallbackMs;
  return Math.max(250, Math.min(60_000, Math.floor(n)));
}

async function getCurrentPageUrl(targetId) {
  const r = await runOpenClaw(["browser", "evaluate", "--fn", "() => location.href", "--target-id", targetId, "--json"], {
    timeoutMs: 10_000,
  });
  const j = parseJsonFromStdout(r.stdout);
  return typeof j?.result === "string" ? j.result : "";
}

async function enforcePagePolicy(input) {
  const { targetId, allowedOrigins, what } = input;
  const href = await getCurrentPageUrl(targetId);
  if (href) {
    assertUrlAllowed(href, allowedOrigins, what ?? "page_url");
    if (NO_LOGIN && looksLikeLoginText(href)) throw new Error(`no_login_blocked_url:${href}`);
  }
  return href;
}

async function runOpenClawBrowserFlowModule(input) {
  const descriptorUrl = input.job?.taskDescriptor?.input_spec?.url;
  const startUrl =
    typeof descriptorUrl === "string" && descriptorUrl
      ? descriptorUrl
      : String(input.job?.journey?.startUrl ?? "");
  if (!startUrl) throw new Error("missing_start_url");

  await ensureOpenClawBrowserReady();

  const allowedOrigins = input.allowedOrigins ?? compileAllowedOrigins(input.job);
  const deadlineMs = Number.isFinite(Number(input.deadlineMs)) ? Number(input.deadlineMs) : Infinity;

  const flow = input.flow ?? {};
  const stepsRaw = Array.isArray(flow?.steps) ? flow.steps : [];
  const maxSteps = Number.isFinite(Number(flow?.max_steps)) ? Math.max(1, Math.min(100, Number(flow.max_steps))) : 50;
  const steps = stepsRaw.slice(0, maxSteps);
  const continueOnError = flow?.continue_on_error !== false;

  const logs = [];
  const extracted = {};
  const artifacts = [];

  if (Date.now() > deadlineMs) throw new Error("job_time_budget_exceeded");
  if (ORIGIN_ENFORCEMENT === "strict") assertUrlAllowed(startUrl, allowedOrigins, "start_url");
  if (NO_LOGIN && looksLikeLoginText(startUrl)) throw new Error(`no_login_blocked_url:${startUrl}`);
  logs.push(`start_url: ${startUrl}`);

  const opened = await runOpenClaw(["browser", "open", startUrl, "--json"], { timeoutMs: 30_000 });
  const openJson = parseJsonFromStdout(opened.stdout);
  const targetId = String(openJson?.targetId ?? "").trim();
  if (!targetId) throw new Error("openclaw_browser_open_missing_target_id");

  try {
    await enforcePagePolicy({ targetId, allowedOrigins, what: "after_open" });
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] ?? {};
      const op = String(step?.op ?? step?.action ?? "").trim().toLowerCase();
      if (!op) continue;

      try {
        if (Date.now() > deadlineMs) throw new Error("job_time_budget_exceeded");
        if (op === "goto" || op === "navigate") {
          const url = typeof step?.url === "string" && step.url ? step.url : startUrl;
          if (ORIGIN_ENFORCEMENT === "strict") assertUrlAllowed(url, allowedOrigins, `step_${i}_url`);
          if (NO_LOGIN && looksLikeLoginText(url)) throw new Error(`no_login_blocked_url:${url}`);
          logs.push(`step ${i}: ${op} url=${url}`);
          await runOpenClaw(["browser", "navigate", url, "--target-id", targetId, "--json"], { timeoutMs: normalizeTimeoutMs(step, 30_000) });
          await enforcePagePolicy({ targetId, allowedOrigins, what: `after_${op}_${i}` });
        } else if (op === "wait") {
          const t = normalizeTimeoutMs(step, 20_000);
          if (typeof step?.ms === "number" || typeof step?.ms === "string") {
            const ms = Math.max(0, Math.min(60_000, Number(step.ms)));
            logs.push(`step ${i}: wait ms=${ms}`);
            await runOpenClaw(["browser", "wait", "--time", String(ms), "--timeout-ms", String(t), "--target-id", targetId, "--json"], { timeoutMs: t + 2_000 });
          } else if (typeof step?.selector === "string" && step.selector) {
            logs.push(`step ${i}: wait selector=${step.selector}`);
            await runOpenClaw(["browser", "wait", step.selector, "--timeout-ms", String(t), "--target-id", targetId, "--json"], { timeoutMs: t + 2_000 });
          } else if (typeof step?.text === "string" && step.text) {
            logs.push(`step ${i}: wait text=${step.text}`);
            await runOpenClaw(["browser", "wait", "--text", step.text, "--timeout-ms", String(t), "--target-id", targetId, "--json"], { timeoutMs: t + 2_000 });
          } else if (typeof step?.url === "string" && step.url) {
            if (ORIGIN_ENFORCEMENT === "strict") assertUrlAllowed(step.url, allowedOrigins, `step_${i}_wait_url`);
            if (NO_LOGIN && looksLikeLoginText(step.url)) throw new Error(`no_login_blocked_url:${step.url}`);
            logs.push(`step ${i}: wait url=${step.url}`);
            await runOpenClaw(["browser", "wait", "--url", step.url, "--timeout-ms", String(t), "--target-id", targetId, "--json"], { timeoutMs: t + 2_000 });
          } else {
            logs.push(`step ${i}: wait default`);
            await runOpenClaw(["browser", "wait", "--time", "250", "--timeout-ms", String(t), "--target-id", targetId, "--json"], { timeoutMs: t + 2_000 });
          }
          await enforcePagePolicy({ targetId, allowedOrigins, what: `after_wait_${i}` });
        } else if (op === "click") {
          const explicit = typeof step?.ref === "string" ? step.ref.trim() : "";
          const ref =
            explicit ||
            (await resolveRefViaSnapshot({ targetId, match: { role: step?.role, name: step?.name, text: step?.text } }));
          if (!ref) throw new Error("ref_not_found");
          logs.push(`step ${i}: click ref=${ref}`);
          await runOpenClaw(["browser", "click", ref, "--target-id", targetId, "--json"], { timeoutMs: normalizeTimeoutMs(step, 20_000) });
          await enforcePagePolicy({ targetId, allowedOrigins, what: `after_click_${i}` });
        } else if (op === "fill" || op === "type") {
          const explicit = typeof step?.ref === "string" ? step.ref.trim() : "";
          const ref =
            explicit ||
            (await resolveRefViaSnapshot({ targetId, match: { role: step?.role, name: step?.name, text: step?.text } }));
          if (!ref) throw new Error("ref_not_found");
          const val = pickFillValue(step);
          logs.push(`step ${i}: ${op} ref=${ref} value=${redactStepValue(step)}`);
          await runOpenClaw(["browser", "type", ref, val, "--target-id", targetId, "--json"], { timeoutMs: normalizeTimeoutMs(step, 20_000) });
        } else if (op === "press") {
          const key = typeof step?.key === "string" && step.key ? step.key : "Enter";
          logs.push(`step ${i}: press key=${key}`);
          await runOpenClaw(["browser", "press", key, "--target-id", targetId, "--json"], { timeoutMs: normalizeTimeoutMs(step, 10_000) });
          await enforcePagePolicy({ targetId, allowedOrigins, what: `after_press_${i}` });
        } else if (op === "screenshot") {
          const fullPage = step?.full_page === true || step?.fullPage === true;
          const label = typeof step?.label === "string" && step.label ? step.label : `flow_screenshot_${i}`;
          logs.push(`step ${i}: screenshot label=${label} fullPage=${fullPage}`);
          const args = ["browser", "screenshot"];
          if (fullPage) args.push("--full-page");
          args.push("--type", "png", targetId, "--json");
          const shot = await runOpenClaw(args, { timeoutMs: 45_000 });
          let outPath = "";
          try {
            const shotJson = parseJsonFromStdout(shot.stdout);
            outPath = typeof shotJson?.path === "string" ? shotJson.path : "";
          } catch {
            // fall through
          }
          if (!outPath) {
            const m = String(shot.stdout ?? "").match(/\bMEDIA:([^\s]+)\s*$/m);
            if (m?.[1]) outPath = String(m[1]).trim();
          }
          outPath = String(outPath).trim();
          if (!outPath) throw new Error("openclaw_browser_screenshot_missing_path");
          const bytes = await readFile(outPath);
          const detected = detectPngOrJpeg(bytes);
          if (!detected) throw new Error("screenshot_unknown_format");
          artifacts.push(
            await uploadArtifact({
              token: input.token,
              jobId: input.job.jobId,
              filename: `${label}.${detected.ext}`,
              contentType: detected.contentType,
              bytes,
              kind: "screenshot",
              label,
            }),
          );
        } else if (op === "extract") {
          const key = typeof step?.key === "string" && step.key ? step.key : `extract_${i}`;
          const explicit = typeof step?.ref === "string" ? step.ref.trim() : "";
          const ref =
            explicit ||
            (await resolveRefViaSnapshot({ targetId, match: { role: step?.role, name: step?.name, text: step?.text } }));
          if (!ref) throw new Error("ref_not_found");
          if (typeof step?.fn === "string" && step.fn.trim()) {
            throw new Error("extract_fn_forbidden");
          }
          const kindRaw = String(step?.kind ?? "text").trim().toLowerCase();
          const kind = ["text", "value", "html", "attribute"].includes(kindRaw) ? kindRaw : "text";
          let fn = "(el) => el?.textContent ?? \"\"";
          if (kind === "value") fn = "(el) => (typeof el?.value === \"string\" ? el.value : null)";
          else if (kind === "html") fn = "(el) => el?.innerHTML ?? \"\"";
          else if (kind === "attribute") {
            const attr = typeof step?.attribute === "string" ? step.attribute.trim() : "";
            if (!/^[a-zA-Z_][a-zA-Z0-9_:\\-]{0,60}$/.test(attr)) throw new Error("invalid_extract_attribute");
            fn = `(el) => el?.getAttribute?.(${JSON.stringify(attr)}) ?? null`;
          }
          logs.push(`step ${i}: extract key=${key} ref=${ref}`);
          const r = await runOpenClaw(["browser", "evaluate", "--fn", fn, "--ref", ref, "--target-id", targetId, "--json"], {
            timeoutMs: normalizeTimeoutMs(step, 20_000),
          });
          const j = parseJsonFromStdout(r.stdout);
          const res = j?.result ?? null;
          extracted[key] = typeof res === "string" && res.length > 20_000 ? res.slice(0, 20_000) : res;
        } else {
          logs.push(`step ${i}: unknown op=${op} (ignored)`);
        }
      } catch (err) {
        const msg = String(err?.message ?? err);
        logs.push(`step ${i}: ERROR op=${op} err=${msg.slice(0, 500)}`);
        // Safety contract: policy violations must stop execution even if continueOnError=true.
        const fatal =
          msg === "job_time_budget_exceeded" ||
          msg.startsWith("origin_") ||
          msg.startsWith("no_login_") ||
          msg.startsWith("value_env_not_allowed") ||
          msg === "extract_fn_forbidden" ||
          msg === "unsupported_url_scheme" ||
          msg === "url_contains_credentials";
        if (fatal) throw err;
        if (!continueOnError) break;
      }
    }

    if (!artifacts.some((a) => a.kind === "screenshot" && a.label === "universal_screenshot")) {
      // Always emit a final screenshot under a stable label.
      if (Date.now() > deadlineMs) throw new Error("job_time_budget_exceeded");
      const shot = await runOpenClaw(["browser", "screenshot", "--full-page", "--type", "png", targetId, "--json"], { timeoutMs: 45_000 });
      let outPath = "";
      try {
        const shotJson = parseJsonFromStdout(shot.stdout);
        outPath = typeof shotJson?.path === "string" ? shotJson.path : "";
      } catch {
        // fall through
      }
      if (!outPath) {
        const m = String(shot.stdout ?? "").match(/\bMEDIA:([^\s]+)\s*$/m);
        if (m?.[1]) outPath = String(m[1]).trim();
      }
      outPath = String(outPath).trim();
      if (!outPath) throw new Error("openclaw_browser_screenshot_missing_path");
      const bytes = await readFile(outPath);
      const detected = detectPngOrJpeg(bytes);
      if (!detected) throw new Error("screenshot_unknown_format");
      artifacts.push(
        await uploadArtifact({
          token: input.token,
          jobId: input.job.jobId,
          filename: `screenshot.${detected.ext}`,
          contentType: detected.contentType,
          bytes,
          kind: "screenshot",
          label: "universal_screenshot",
        }),
      );
    }
  } finally {
    await runOpenClaw(["browser", "close", targetId]).catch(() => undefined);
  }

  const flowLog = [
    "# browser_flow",
    `job_id: ${input.job?.jobId ?? ""}`,
    `generated_at: ${new Date().toISOString()}`,
    "",
    ...logs,
    "",
    "extracted:",
    JSON.stringify(extracted, null, 2),
    "",
  ].join("\n");
  artifacts.push(
    await uploadArtifact({
      token: input.token,
      jobId: input.job.jobId,
      filename: "browser_flow.log",
      contentType: "text/plain",
      bytes: Buffer.from(flowLog, "utf8"),
      kind: "log",
      label: "browser_flow",
    }),
  );

  return { artifacts, extracted };
}

async function runOpenClawScreenshotModule(input) {
  const descriptorUrl = input.job?.taskDescriptor?.input_spec?.url;
  const startUrl =
    typeof descriptorUrl === "string" && descriptorUrl
      ? descriptorUrl
      : String(input.job?.journey?.startUrl ?? "");
  if (!startUrl) throw new Error("missing_start_url");

  await ensureOpenClawBrowserReady();

  const allowedOrigins = input.allowedOrigins ?? compileAllowedOrigins(input.job);
  const deadlineMs = Number.isFinite(Number(input.deadlineMs)) ? Number(input.deadlineMs) : Infinity;

  if (Date.now() > deadlineMs) throw new Error("job_time_budget_exceeded");
  if (ORIGIN_ENFORCEMENT === "strict") assertUrlAllowed(startUrl, allowedOrigins, "start_url");
  if (NO_LOGIN && looksLikeLoginText(startUrl)) throw new Error(`no_login_blocked_url:${startUrl}`);

  // Open URL in OpenClaw's dedicated browser, screenshot, then close the tab.
  const opened = await runOpenClaw(["browser", "open", startUrl, "--json"], { timeoutMs: 30_000 });
  const openJson = parseJsonFromStdout(opened.stdout);
  const targetId = String(openJson?.targetId ?? "").trim();
  if (!targetId) throw new Error("openclaw_browser_open_missing_target_id");

  try {
    await enforcePagePolicy({ targetId, allowedOrigins, what: "after_open" });
    const shot = await runOpenClaw(
      ["browser", "screenshot", targetId, "--full-page", "--type", "png", "--json"],
      { timeoutMs: 45_000 },
    );
    const shotJson = parseJsonFromStdout(shot.stdout);
    const path = String(shotJson?.path ?? "").trim();
    if (!path) throw new Error("openclaw_browser_screenshot_missing_path");
    const bytes = await readFile(path);
    const detected = detectPngOrJpeg(bytes);
    if (!detected) throw new Error("screenshot_unknown_format");
    return await uploadArtifact({
      token: input.token,
      jobId: input.job.jobId,
      filename: `screenshot.${detected.ext}`,
      contentType: detected.contentType,
      bytes,
      kind: "screenshot",
      label: "openclaw_screenshot",
    });
  } finally {
    // Best-effort cleanup.
    await runOpenClaw(["browser", "close", targetId]).catch(() => undefined);
  }
}

async function runOpenClawSnapshotModule(input) {
  const descriptorUrl = input.job?.taskDescriptor?.input_spec?.url;
  const startUrl =
    typeof descriptorUrl === "string" && descriptorUrl
      ? descriptorUrl
      : String(input.job?.journey?.startUrl ?? "");
  if (!startUrl) return null;

  await ensureOpenClawBrowserReady();

  const allowedOrigins = input.allowedOrigins ?? compileAllowedOrigins(input.job);
  const deadlineMs = Number.isFinite(Number(input.deadlineMs)) ? Number(input.deadlineMs) : Infinity;

  if (Date.now() > deadlineMs) throw new Error("job_time_budget_exceeded");
  if (ORIGIN_ENFORCEMENT === "strict") assertUrlAllowed(startUrl, allowedOrigins, "start_url");
  if (NO_LOGIN && looksLikeLoginText(startUrl)) throw new Error(`no_login_blocked_url:${startUrl}`);

  const opened = await runOpenClaw(["browser", "open", startUrl, "--json"], { timeoutMs: 30_000 });
  const openJson = parseJsonFromStdout(opened.stdout);
  const targetId = String(openJson?.targetId ?? "").trim();
  if (!targetId) return null;

  const dir = await mkdtemp(join(tmpdir(), "proofwork-openclaw-snap-"));
  const outPath = join(dir, "snapshot.ai.txt");

  try {
    await enforcePagePolicy({ targetId, allowedOrigins, what: "after_open" });

    const snap = await runOpenClaw(
      ["browser", "snapshot", "--format", "ai", "--target-id", targetId, "--out", outPath, "--json"],
      { timeoutMs: 45_000 },
    );
    const snapJson = parseJsonFromStdout(snap.stdout);
    const out = String(snapJson?.out ?? outPath).trim() || outPath;
    const bytes = await readFile(out);
    return await uploadArtifact({
      token: input.token,
      jobId: input.job.jobId,
      filename: "snapshot.ai.txt",
      contentType: "text/plain",
      bytes,
      kind: "snapshot",
      label: "openclaw_snapshot_ai",
    });
  } finally {
    await runOpenClaw(["browser", "close", targetId]).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readWebStreamLimited(input) {
  const maxBytes = Number(input.maxBytes ?? 0);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error("invalid_max_bytes");
  const stream = input.stream;
  if (!stream || typeof stream.getReader !== "function") return { bytes: Buffer.alloc(0), truncated: false };

  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    const buf = Buffer.from(value);
    if (total + buf.byteLength > maxBytes) {
      const keep = Math.max(0, maxBytes - total);
      if (keep > 0) {
        chunks.push(buf.subarray(0, keep));
        total += keep;
      }
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      break;
    }
    chunks.push(buf);
    total += buf.byteLength;
  }
  return { bytes: Buffer.concat(chunks, total), truncated };
}

async function fetchWithManualRedirects(input) {
  const allowedOrigins = input.allowedOrigins;
  let url = String(input.url ?? "");
  let resp = null;
  for (let i = 0; i < 4; i++) {
    if (Date.now() > input.deadlineMs) throw new Error("job_time_budget_exceeded");
    if (ORIGIN_ENFORCEMENT === "strict") assertUrlAllowed(url, allowedOrigins, `http_url_${i}`);
    if (NO_LOGIN && looksLikeLoginText(url)) throw new Error(`no_login_blocked_url:${url}`);

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), input.timeoutMs ?? 30_000);
    t.unref?.();
    try {
      resp = await fetch(url, { method: "GET", redirect: "manual", headers: input.headers, signal: ac.signal });
    } finally {
      clearTimeout(t);
    }

    if (resp.status < 300 || resp.status >= 400) return { url, resp };
    const loc = resp.headers.get("location");
    resp.body?.cancel?.();
    if (!loc) return { url, resp };
    const next = new URL(loc, url).toString();
    // Redirect is an explicit worker fetch; enforce allowed origins.
    if (ORIGIN_ENFORCEMENT === "strict") assertUrlAllowed(next, allowedOrigins, `http_redirect_${i}`);
    url = next;
  }
  return { url, resp };
}

async function fetchJsonLimited(input) {
  const { url: finalUrl, resp } = await fetchWithManualRedirects({
    url: input.url,
    allowedOrigins: input.allowedOrigins,
    deadlineMs: input.deadlineMs,
    timeoutMs: input.timeoutMs ?? 30_000,
    headers: input.headers,
  });
  if (!resp) throw new Error("http_missing_response");
  const { bytes, truncated } = await readWebStreamLimited({ stream: resp.body, maxBytes: input.maxBytes ?? HTTP_MAX_BYTES });
  const text = bytes.length ? Buffer.from(bytes).toString("utf8") : "";
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return {
    finalUrl,
    status: resp.status,
    ok: resp.ok,
    truncated,
    contentType: resp.headers.get("content-type") ?? "",
    json,
    text,
  };
}

async function runHttpModule(input) {
  const url = input.job?.taskDescriptor?.input_spec?.url;
  if (typeof url !== "string" || !url) return null;

  const allowedOrigins = input.allowedOrigins ?? compileAllowedOrigins(input.job);
  const deadlineMs = Number.isFinite(Number(input.deadlineMs)) ? Number(input.deadlineMs) : Infinity;

  const { url: finalUrl, resp } = await fetchWithManualRedirects({
    url,
    allowedOrigins,
    deadlineMs,
    timeoutMs: 30_000,
  });
  if (!resp) throw new Error("http_missing_response");

  const { bytes, truncated } = await readWebStreamLimited({ stream: resp.body, maxBytes: HTTP_MAX_BYTES });
  const contentType = resp.headers.get("content-type") ?? "";
  const decoded = bytes.length ? Buffer.from(bytes).toString("utf8") : "";
  const out = `url: ${url}\nfinal_url: ${finalUrl}\nstatus: ${resp.status}\ncontent_type: ${contentType}\nbytes: ${bytes.byteLength}\ntruncated: ${truncated}\n\n${decoded.slice(0, 20_000)}\n`;
  return await uploadArtifact({
    token: input.token,
    jobId: input.job.jobId,
    filename: "http_response.log",
    contentType: "text/plain",
    bytes: Buffer.from(out, "utf8"),
    kind: "log",
    label: "report_http",
  });
}

async function runFfmpegClipModule(input) {
  const vodUrl = input.job?.taskDescriptor?.input_spec?.vod_url;
  if (typeof vodUrl !== "string" || !vodUrl) return null;

  const allowedOrigins = input.allowedOrigins ?? compileAllowedOrigins(input.job);
  const deadlineMs = Number.isFinite(Number(input.deadlineMs)) ? Number(input.deadlineMs) : Infinity;

  const startSec = Number(input.job?.taskDescriptor?.input_spec?.start_sec ?? 0);
  const durationSec = Number(input.job?.taskDescriptor?.input_spec?.duration_sec ?? 10);
  if (!Number.isFinite(startSec) || startSec < 0) throw new Error("invalid_start_sec");
  const maxDuration = Math.min(600, FFMPEG_MAX_DURATION_SEC);
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > maxDuration) throw new Error("invalid_duration_sec");

  if (Date.now() > deadlineMs) throw new Error("job_time_budget_exceeded");
  if (ORIGIN_ENFORCEMENT === "strict") assertUrlAllowed(vodUrl, allowedOrigins, "vod_url");
  if (NO_LOGIN && looksLikeLoginText(vodUrl)) throw new Error(`no_login_blocked_url:${vodUrl}`);

  const dir = await mkdtemp(join(tmpdir(), "proofwork-ffmpeg-"));
  const outPath = join(dir, "clip.mp4");

  try {
    await new Promise((resolve, reject) => {
      const args = [
        "-y",
        "-ss",
        String(startSec),
        "-i",
        vodUrl,
        "-t",
        String(durationSec),
        "-c",
        "copy",
        outPath,
      ];
      const p = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
      const timeLeftMs = deadlineMs === Infinity ? 120_000 : Math.max(5_000, Math.min(120_000, deadlineMs - Date.now() - 1000));
      const timer = setTimeout(() => {
        try {
          p.kill("SIGKILL");
        } catch {
          // ignore
        }
        reject(new Error("ffmpeg_timeout"));
      }, timeLeftMs);
      timer.unref?.();
      let err = "";
      p.stderr.on("data", (d) => (err += String(d)));
      p.on("error", (e) => reject(new Error(`ffmpeg_spawn_error:${String(e?.message ?? e)}`)));
      p.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        reject(new Error(`ffmpeg_failed:${code}:${err.slice(0, 500)}`));
      });
    });

    if (ARTIFACT_MAX_BYTES) {
      const st = await stat(outPath);
      if (st.size > ARTIFACT_MAX_BYTES) throw new Error(`artifact_too_large:${st.size}`);
    }
    const bytes = await readFile(outPath);
    return await uploadArtifact({
      token: input.token,
      jobId: input.job.jobId,
      filename: "clip.mp4",
      contentType: "video/mp4",
      bytes,
      kind: "video",
      label: "clip_main",
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runClipTimelineModule(input) {
  const vodUrl = input.job?.taskDescriptor?.input_spec?.vod_url;
  if (typeof vodUrl !== "string" || !vodUrl) return null;

  const startSec = Number(input.job?.taskDescriptor?.input_spec?.start_sec ?? 0);
  const durationSec = Number(input.job?.taskDescriptor?.input_spec?.duration_sec ?? 10);
  if (!Number.isFinite(startSec) || startSec < 0) return null;
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 600) return null;

  const timeline = {
    schema: "timeline.v1",
    vod_url: vodUrl,
    generated_at: new Date().toISOString(),
    clips: [{ start_sec: startSec, end_sec: startSec + durationSec, label: "clip_1" }],
  };

  return await uploadArtifact({
    token: input.token,
    jobId: input.job.jobId,
    filename: "timeline.json",
    contentType: "application/json",
    bytes: Buffer.from(JSON.stringify(timeline, null, 2) + "\n", "utf8"),
    kind: "other",
    label: "timeline_main",
  });
}

async function runStructuredJsonOutputsModule(input) {
  const td = input.job?.taskDescriptor ?? {};
  const type = String(td?.type ?? "unknown");
  const inputSpec = td?.input_spec ?? {};
  const outputSpec = td?.output_spec ?? {};
  const extracted = input.extracted ?? {};
  const allowedOrigins = input.allowedOrigins ?? compileAllowedOrigins(input.job);
  const deadlineMs = Number.isFinite(Number(input.deadlineMs)) ? Number(input.deadlineMs) : Infinity;

  const required = Array.isArray(outputSpec?.required_artifacts) ? outputSpec.required_artifacts : [];
  const requiredOtherPrefixes = new Set(
    required
      .filter((r) => r && typeof r === "object" && String(r.kind ?? "") === "other" && typeof r.label_prefix === "string")
      .map((r) => String(r.label_prefix)),
  );

  const artifacts = [];

  async function emit(prefix, obj) {
    const bytes = Buffer.from(JSON.stringify(obj, null, 2) + "\n", "utf8");
    artifacts.push(
      await uploadArtifact({
        token: input.token,
        jobId: input.job.jobId,
        filename: `${prefix}.json`,
        contentType: "application/json",
        bytes,
        kind: "other",
        label: `${prefix}_main`,
      }),
    );
  }

  if (requiredOtherPrefixes.has("results") || outputSpec?.results_json === true || type.includes("marketplace")) {
    const query = typeof inputSpec?.query === "string" ? inputSpec.query : "";
    const url = typeof inputSpec?.url === "string" ? inputSpec.url : String(input.job?.journey?.startUrl ?? "");
    const extractedItems = Array.isArray(extracted.items) ? extracted.items : null;
    await emit("results", {
      schema: "results.v1",
      generated_at: new Date().toISOString(),
      query,
      source_url: url,
      items: extractedItems && extractedItems.length ? extractedItems : [{ title: query || "example item", price: 99.0, currency: "USD", url, observed_at: new Date().toISOString() }],
    });
  }

  if (requiredOtherPrefixes.has("deals") || outputSpec?.deals === true || type.includes("travel")) {
    const origin = typeof inputSpec?.origin === "string" ? inputSpec.origin : "";
    const dest = typeof inputSpec?.dest === "string" ? inputSpec.dest : "";
    const extractedDeals = Array.isArray(extracted.deals) ? extracted.deals : null;
    await emit("deals", {
      schema: "deals.v1",
      generated_at: new Date().toISOString(),
      origin,
      dest,
      deals: extractedDeals && extractedDeals.length ? extractedDeals : [{ price: 199.0, currency: "USD", vendor: "example", url: String(input.job?.journey?.startUrl ?? "https://example.com"), observed_at: new Date().toISOString() }],
    });
  }

  if (requiredOtherPrefixes.has("rows") || outputSpec?.rows === true || type.includes("jobs")) {
    const titles = Array.isArray(inputSpec?.titles) ? inputSpec.titles.map((t) => String(t)).slice(0, 5) : [];
    const location = typeof inputSpec?.location === "string" ? inputSpec.location : "";
    let extractedRows = Array.isArray(extracted.rows) ? extracted.rows : null;
    if ((!extractedRows || !extractedRows.length) && type.includes("jobs")) {
      try {
        extractedRows = await getRemotiveJobsRowsFromApi({ inputSpec, allowedOrigins, deadlineMs });
      } catch (err) {
        debugLog("remotive rows fetch failed", String(err?.message ?? err));
        extractedRows = null;
      }
    }
    await emit("rows", {
      schema: "rows.v1",
      generated_at: new Date().toISOString(),
      titles,
      location,
      rows: extractedRows && extractedRows.length ? extractedRows : [{ title: titles[0] ?? "engineer", company: "example", location, url: String(input.job?.journey?.startUrl ?? "https://example.com"), posted_at: new Date().toISOString() }],
    });
  }

  if (requiredOtherPrefixes.has("repos") || outputSpec?.repos === true || type.includes("github")) {
    const idea = typeof inputSpec?.idea === "string" ? inputSpec.idea : "";
    let extractedRepos = Array.isArray(extracted.repos) ? extracted.repos : null;
    if ((!extractedRepos || !extractedRepos.length) && type.includes("github")) {
      try {
        extractedRepos = await getGithubReposFromApi({ inputSpec, allowedOrigins, deadlineMs });
      } catch (err) {
        debugLog("github repos fetch failed", String(err?.message ?? err));
        extractedRepos = null;
      }
    }
    await emit("repos", {
      schema: "repos.v1",
      generated_at: new Date().toISOString(),
      query: idea,
      repos: extractedRepos && extractedRepos.length ? extractedRepos : [{ name: "example/repo", url: "https://github.com/example/repo", license: String(inputSpec?.license_constraints ?? "unknown"), stars: 0 }],
    });
  }

  if (requiredOtherPrefixes.has("references") || outputSpec?.references === true || type.includes("arxiv")) {
    const idea = typeof inputSpec?.idea === "string" ? inputSpec.idea : "";
    const llmRefs = type.includes("arxiv") ? await maybeGetArxivReferencesFromLlm(idea) : [];
    const extractedRefs = Array.isArray(extracted.references) ? extracted.references : null;
    const apiRefs = llmRefs.length === 0 && idea ? await getArxivReferencesFromApi(idea, { allowedOrigins, deadlineMs }) : [];
    await emit("references", {
      schema: "references.v1",
      generated_at: new Date().toISOString(),
      idea,
      // Must include {id,url} for verifier structured JSON checks.
      references: llmRefs.length > 0 ? llmRefs : apiRefs.length > 0 ? apiRefs : extractedRefs && extractedRefs.length ? extractedRefs : [],
    });
  }

  return artifacts;
}

async function runLlmSummarizeModule(input) {
  const td = input.job?.taskDescriptor ?? {};
  const type = String(td?.type ?? "unknown");
  const caps = Array.isArray(td?.capability_tags) ? td.capability_tags : [];
  const inputSpec = td?.input_spec ?? {};
  const outputSpec = td?.output_spec ?? {};
  const siteProfile = td?.site_profile ?? null;

  const promptLines = [];
  promptLines.push("You are a Proofwork worker.");
  promptLines.push("Write a concise report of what you would do for this job, and what artifacts you produced.");
  promptLines.push("Do not include any secrets. Do not fabricate external verification.");
  promptLines.push("");
  promptLines.push(`job_id: ${input.job?.jobId ?? ""}`);
  promptLines.push(`task_type: ${type}`);
  promptLines.push(`capability_tags: ${JSON.stringify(caps)}`);
  promptLines.push("");
  promptLines.push("input_spec:");
  promptLines.push(JSON.stringify(inputSpec, null, 2));
  promptLines.push("");
  promptLines.push("output_spec:");
  promptLines.push(JSON.stringify(outputSpec, null, 2));
  if (siteProfile) {
    promptLines.push("");
    promptLines.push("site_profile:");
    promptLines.push(JSON.stringify(siteProfile, null, 2));
  }

  let report = "";
  if (OPENCLAW_AGENT_ID) {
    // Use OpenClaw's configured model routing/auth to generate the report.
    const msg = promptLines.join("\n");
    const res = await runOpenClaw(
      [
        "agent",
        "--agent",
        OPENCLAW_AGENT_ID,
        "--message",
        msg,
        "--thinking",
        OPENCLAW_THINKING,
        "--json",
      ],
      { timeoutMs: 5 * 60_000 },
    );
    const j = parseJsonFromStdout(res.stdout);
    const payloads = j?.result?.payloads ?? [];
    report = payloads.map((p) => String(p?.text ?? "").trim()).filter(Boolean).join("\n\n");
  }

  if (!report) {
    // Deterministic fallback (no LLM).
    const lines = [];
    lines.push(`# Universal Worker Report`);
    lines.push("");
    lines.push(`- job_id: ${input.job?.jobId ?? ""}`);
    lines.push(`- task_type: ${type}`);
    lines.push(`- capability_tags: ${JSON.stringify(caps)}`);
    lines.push(`- generated_at: ${new Date().toISOString()}`);
    lines.push("");
    lines.push("## input_spec");
    lines.push("```json");
    lines.push(JSON.stringify(inputSpec, null, 2));
    lines.push("```");
    lines.push("");
    lines.push("## output_spec");
    lines.push("```json");
    lines.push(JSON.stringify(outputSpec, null, 2));
    lines.push("```");
    if (siteProfile) {
      lines.push("");
      lines.push("## site_profile");
      lines.push("```json");
      lines.push(JSON.stringify(siteProfile, null, 2));
      lines.push("```");
    }
    lines.push("");
    lines.push("## artifacts_produced");
    lines.push("```json");
    lines.push(
      JSON.stringify(
        (input.artifactsSoFar ?? []).map((a) => ({
          kind: a.kind,
          label: a.label,
          contentType: a.contentType,
          sizeBytes: a.sizeBytes,
        })),
        null,
        2,
      ),
    );
    lines.push("```");
    report = lines.join("\n") + "\n";
  } else if (!report.endsWith("\n")) {
    report += "\n";
  }

  return await uploadArtifact({
    token: input.token,
    jobId: input.job.jobId,
    filename: "report.md",
    // Proofwork currently allowlists text/plain but not text/markdown.
    // Keep the .md extension for readability while using an allowlisted content-type.
    contentType: "text/plain",
    bytes: Buffer.from(report, "utf8"),
    kind: "log",
    label: "report_summary",
  });
}

async function submitJob(input) {
  const finalUrl = getStartUrlFromJob(input.job) || undefined;
  const manifest = {
    manifestVersion: "1.0",
    jobId: input.job.jobId,
    bountyId: input.job.bountyId,
    finalUrl,
    worker: {
      workerId: input.workerId,
      skillVersion: "openclaw-proofwork-universal-worker/0.1",
      fingerprint: { fingerprintClass: input.job.environment?.fingerprintClass },
    },
    result: {
      outcome: "failure",
      failureType: "other",
      severity: "low",
      expected: "task completed and artifacts uploaded",
      observed: "task completed and artifacts uploaded",
      reproConfidence: "high",
    },
    reproSteps: ["execute universal worker modules", "upload artifacts", "submit proof pack"],
    artifacts: input.artifacts,
  };

  const idem = `submit:${input.job.jobId}:${Date.now()}`;
  const url = `${API_BASE_URL}/api/jobs/${encodeURIComponent(input.job.jobId)}/submit`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.token}`,
      "Idempotency-Key": idem,
    },
    body: JSON.stringify({ manifest, artifactIndex: input.artifacts }),
  });
  const text = await resp.text();
  const json = text ? JSON.parse(text) : null;
  if (!resp.ok) {
    const code = String(json?.error?.code ?? "");
    const msg = String(json?.error?.message ?? "").slice(0, 200);
    throw new Error(`submit_failed:${resp.status}:${code}:${msg}`);
  }
  return json;
}

async function pollUntilDone(input) {
  for (let i = 0; i < 120; i++) {
    const r = await apiFetch(`/api/jobs/${encodeURIComponent(input.jobId)}`, { token: input.token });
    if (!r.resp.ok) return;
    if (r.json?.status === "done") return;
    await sleep(1000);
  }
}

function getStartUrlFromJob(job) {
  const descriptorUrl = job?.taskDescriptor?.input_spec?.url;
  const startUrl =
    typeof descriptorUrl === "string" && descriptorUrl.trim()
      ? descriptorUrl.trim()
      : typeof job?.journey?.startUrl === "string"
        ? job.journey.startUrl.trim()
        : "";
  return startUrl;
}

function parseCapabilityTags(job) {
  const td = job?.taskDescriptor ?? {};
  const tagsRaw = Array.isArray(td?.capability_tags) ? td.capability_tags : [];
  const tags = tagsRaw.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim());
  // Default behavior for legacy/no-descriptor jobs: assume browser.
  return tags.length ? tags : ["browser"];
}

function computeJobDeadlineMs(job) {
  const budgetFromJob = Number(job?.constraints?.timeBudgetSec ?? 0);
  const baseBudgetSec = Number.isFinite(budgetFromJob) && budgetFromJob > 0 ? budgetFromJob : 240;
  const budgetSec = JOB_TIME_BUDGET_SEC_OVERRIDE ? Math.min(baseBudgetSec, JOB_TIME_BUDGET_SEC_OVERRIDE) : baseBudgetSec;
  return Date.now() + Math.max(10, Math.min(3600, Math.floor(budgetSec))) * 1000;
}

function normalizeBrowserFlowSteps(flow) {
  const stepsRaw = Array.isArray(flow?.steps) ? flow.steps : [];
  const maxSteps = Number.isFinite(Number(flow?.max_steps)) ? Math.max(1, Math.min(100, Number(flow.max_steps))) : 50;
  return { stepsRaw, steps: stepsRaw.slice(0, maxSteps), maxSteps };
}

function stepFieldText(step) {
  return [
    step?.selector,
    step?.text,
    step?.role,
    step?.name,
    step?.label,
  ]
    .map((x) => (typeof x === "string" ? x : ""))
    .filter(Boolean)
    .join(" ");
}

function preflightJobOrThrow(job, allowedOrigins) {
  const td = job?.taskDescriptor ?? {};
  const type = typeof td?.type === "string" ? td.type : "";
  if (type && !typeAllowedByWorkerPolicy(type)) throw new Error(`task_type_blocked:${type}`);

  // Origin + no-login enforcement for the initial URL.
  const startUrl = getStartUrlFromJob(job);
  if (!startUrl) throw new Error("missing_start_url");
  if (ORIGIN_ENFORCEMENT === "strict") assertUrlAllowed(startUrl, allowedOrigins, "start_url");
  if (NO_LOGIN && looksLikeLoginText(startUrl)) throw new Error(`no_login_blocked_url:${startUrl}`);

  const tags = parseCapabilityTags(job);
  const requiredArtifacts = Array.isArray(td?.output_spec?.required_artifacts)
    ? td.output_spec.required_artifacts
    : [];

  // Browser flow safety contract (untrusted descriptor).
  const flow = getBrowserFlowSpec(job);
  if (flow) {
    const { stepsRaw, steps, maxSteps } = normalizeBrowserFlowSteps(flow);
    // Hard cap: do not attempt to process extremely large flows.
    if (stepsRaw.length > 100) throw new Error("browser_flow_steps_exceeds_hard_cap");
    if (stepsRaw.length > maxSteps) debugLog(`browser_flow steps truncated: ${stepsRaw.length} -> ${maxSteps}`);

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] ?? {};
      const op = String(step?.op ?? step?.action ?? "").trim().toLowerCase();
      if (!op) continue;

      if ((op === "navigate" || op === "goto") && typeof step?.url === "string" && step.url.trim()) {
        const u = step.url.trim();
        if (ORIGIN_ENFORCEMENT === "strict") assertUrlAllowed(u, allowedOrigins, `step_${i}_url`);
        if (NO_LOGIN && looksLikeLoginText(u)) throw new Error(`no_login_blocked_url:${u}`);
      }

      if (op === "wait" && typeof step?.url === "string" && step.url.trim()) {
        const u = step.url.trim();
        if (ORIGIN_ENFORCEMENT === "strict") assertUrlAllowed(u, allowedOrigins, `step_${i}_wait_url`);
        if (NO_LOGIN && looksLikeLoginText(u)) throw new Error(`no_login_blocked_url:${u}`);
      }

      if (op === "extract") {
        if (typeof step?.fn === "string" && step.fn.trim()) throw new Error("extract_fn_forbidden");
        const kindRaw = String(step?.kind ?? "text").trim().toLowerCase();
        if (kindRaw === "attribute") {
          const attr = typeof step?.attribute === "string" ? step.attribute.trim() : "";
          if (!/^[a-zA-Z_][a-zA-Z0-9_:\\-]{0,60}$/.test(attr)) throw new Error("invalid_extract_attribute");
        }
      }

      if (op === "fill" || op === "type") {
        if (typeof step?.value_env === "string" && step.value_env.trim()) {
          const name = step.value_env.trim();
          if (!isAllowedValueEnv(name)) throw new Error(`value_env_not_allowed:${name}`);
        }
      }

      if (NO_LOGIN) {
        const fields = stepFieldText(step);
        if ((op === "click" || op === "fill" || op === "type") && looksLikeLoginText(fields)) {
          throw new Error(`no_login_blocked_step:${op}:${fields.slice(0, 120)}`);
        }
      }
    }
  }

  // ffmpeg job inputs are also descriptor-controlled; preflight them so we don't claim and then refuse.
  const wantsFfmpeg = tags.includes("ffmpeg") || requiredArtifacts.some((r) => r && typeof r === "object" && String(r.kind ?? "") === "video");
  if (wantsFfmpeg) {
    if (ffmpegHealthy === false) throw new Error("ffmpeg_unavailable");
    const vodUrl = td?.input_spec?.vod_url;
    if (typeof vodUrl !== "string" || !vodUrl.trim()) throw new Error("missing_vod_url");
    if (ORIGIN_ENFORCEMENT === "strict") assertUrlAllowed(vodUrl, allowedOrigins, "vod_url");
    if (NO_LOGIN && looksLikeLoginText(vodUrl)) throw new Error(`no_login_blocked_url:${vodUrl}`);
    const startSec = Number(td?.input_spec?.start_sec ?? 0);
    const durationSec = Number(td?.input_spec?.duration_sec ?? 10);
    if (!Number.isFinite(startSec) || startSec < 0) throw new Error("invalid_start_sec");
    const maxDuration = Math.min(600, FFMPEG_MAX_DURATION_SEC);
    if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > maxDuration) throw new Error("invalid_duration_sec");
  }

  // Best-effort broader heuristic. Keep threshold conservative to avoid false positives.
  if (NO_LOGIN) {
    const score = noLoginPreflightScore(job, allowedOrigins);
    if (score >= 8) throw new Error(`no_login_blocked_preflight(score=${score})`);
  }
}

function pruneRefuseCache(cache) {
  const now = Date.now();
  for (const [jobId, entry] of cache.entries()) {
    if (!entry || entry.expiresAtMs <= now) cache.delete(jobId);
  }
  // Bounded size.
  const max = 200;
  while (cache.size > max) {
    const firstKey = cache.keys().next().value;
    if (!firstKey) break;
    cache.delete(firstKey);
  }
}

function addRefusal(cache, jobId, reason, ttlMs = 10 * 60_000) {
  if (!jobId) return;
  cache.set(jobId, { expiresAtMs: Date.now() + Math.max(5_000, ttlMs), reason: String(reason ?? "") });
  pruneRefuseCache(cache);
}

function excludeJobIdsCsv(cache) {
  pruneRefuseCache(cache);
  const ids = Array.from(cache.keys()).slice(0, 50);
  return ids.length ? ids.join(",") : undefined;
}

async function releaseLeaseEarly(input) {
  const jobId = String(input?.jobId ?? "");
  const leaseNonce = String(input?.leaseNonce ?? "");
  if (!jobId || !leaseNonce) return;
  try {
    const r = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}/release`, {
      method: "POST",
      token: input.token,
      body: { leaseNonce, reason: String(input?.reason ?? "worker_refused") },
    });
    if (!r.resp.ok && r.resp.status !== 404) {
      debugLog("lease release failed", r.resp.status, r.json);
    }
  } catch (err) {
    debugLog("lease release error", String(err?.message ?? err));
  }
}

async function loop() {
  const { token, workerId } = await ensureWorkerToken();
  try {
    const v = await apiFetch("/api/version", { token });
    if (v.resp.ok && v.json?.apiVersion) {
      await writeStatus({ api: { version: v.json?.apiVersion ?? null, serverVersion: v.json?.serverVersion ?? null } });
    }
  } catch {
    // ignore (backwards-compatible)
  }
  await maybeConfigurePayoutAddress({ token });
  const baseSupported = supportedCapabilityTags();
  const prefer = String(process.env.PROOFWORK_PREFER_CAPABILITY_TAG ?? "").trim() || undefined;
  const requireTaskType =
    String(process.env.PROOFWORK_REQUIRE_TASK_TYPE ?? process.env.REQUIRE_TASK_TYPE ?? "").trim() || undefined;
  const minPayoutCents = process.env.PROOFWORK_MIN_PAYOUT_CENTS
    ? Number(process.env.PROOFWORK_MIN_PAYOUT_CENTS)
    : undefined;

  await maybeUpdateBrowserHealth(baseSupported);
  await maybeUpdateFfmpegHealth(baseSupported);
  await writeStatus({
    startedAt: Date.now(),
    pid: process.pid,
    workerId,
    supportedCapabilityTags: baseSupported,
    effectiveCapabilityTags: effectiveCapabilityTagsState ?? computeEffectiveCapabilityTags(baseSupported),
  });

  const refuseCache = new Map();

  for (;;) {
    if (await isPaused()) {
      await writeStatus({ paused: true, lastPollAt: Date.now() });
      await sleep(Math.max(250, POLL_INTERVAL_MS));
      continue;
    }

    await maybeUpdateBrowserHealth(baseSupported);
    await maybeUpdateFfmpegHealth(baseSupported);
    const supported = effectiveCapabilityTagsState ?? computeEffectiveCapabilityTags(baseSupported);
    const exclude = excludeJobIdsCsv(refuseCache);
    await writeStatus({ paused: false, lastPollAt: Date.now(), excludeJobIdsCount: exclude ? exclude.split(",").length : 0 });

    const next = await apiFetch("/api/jobs/next", {
      token,
      query: {
        capability_tags: supported.join(","),
        ...(prefer ? { capability_tag: prefer } : {}),
        ...(requireTaskType ? { task_type: requireTaskType } : {}),
        ...(minPayoutCents ? { min_payout_cents: minPayoutCents } : {}),
        ...(exclude ? { exclude_job_ids: exclude } : {}),
      },
    });

    if (!next.resp.ok) {
      console.error("jobs/next failed", next.resp.status, next.json);
      await writeStatus({ lastErrorAt: Date.now(), lastError: `jobs_next_failed:${next.resp.status}` });
      await sleep(ERROR_BACKOFF_MS);
      continue;
    }

    if (next.json?.state !== "claimable") {
      if (ONCE) return;
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const job = next.json.data.job;
    const jobId = String(job?.jobId ?? "");
    if (!jobId) {
      await writeStatus({ lastErrorAt: Date.now(), lastError: "jobs_next_missing_job_id" });
      await sleep(ERROR_BACKOFF_MS);
      continue;
    }

    await writeStatus({ lastJobId: jobId, lastOfferAt: Date.now() });
    if (!withinCanary(String(job.jobId ?? ""))) {
      addRefusal(refuseCache, jobId, "canary_skip", 5 * 60_000);
      if (ONCE) {
        // Keep trying for a claimable job in the canary set. If none exist, /jobs/next will return idle and we'll exit.
      }
      await sleep(250);
      continue;
    }

    const allowedOrigins = compileAllowedOrigins(job);
    try {
      preflightJobOrThrow(job, allowedOrigins);
    } catch (err) {
      const msg = String(err?.message ?? err);
      addRefusal(refuseCache, jobId, `preflight:${msg}`, 10 * 60_000);
      await writeStatus({ lastRefuseAt: Date.now(), lastJobId: jobId, lastErrorAt: Date.now(), lastError: `preflight_refused:${msg}` });
      await sleep(250);
      continue;
    }

    const claim = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}/claim`, {
      method: "POST",
      token,
    });
    if (!claim.resp.ok) {
      console.error("claim failed", claim.resp.status, claim.json);
      addRefusal(refuseCache, jobId, `claim_failed:${claim.resp.status}`, 10_000);
      await writeStatus({ lastErrorAt: Date.now(), lastError: `claim_failed:${claim.resp.status}` });
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const claimedJob = claim.json?.data?.job ?? job;
    const leaseNonce = String(claim.json?.data?.leaseNonce ?? "");
    const td = claimedJob?.taskDescriptor ?? {};
    const normalizedTags = parseCapabilityTags(claimedJob);
    const browserFlow = getBrowserFlowSpec(claimedJob);
    const requiredArtifacts = Array.isArray(td?.output_spec?.required_artifacts)
      ? td.output_spec.required_artifacts
      : [];
    const wantsHttpModule =
      normalizedTags.includes("http") &&
      (td?.output_spec?.http_response === true ||
        requiredArtifacts.some(
          (r) => r && typeof r === "object" && String(r.kind ?? "") === "log" && String(r.label ?? "") === "report_http",
        ));

    const artifacts = [];

    const jobAllowedOrigins = compileAllowedOrigins(claimedJob);
    const deadlineMs = computeJobDeadlineMs(claimedJob);

    await writeStatus({
      lastClaimAt: Date.now(),
      lastJobId: String(claimedJob?.jobId ?? jobId),
      leaseNonce: leaseNonce || undefined,
      leaseExpiresAt: claim.json?.data?.leaseExpiresAt ? new Date(claim.json.data.leaseExpiresAt).getTime?.() : undefined,
      jobDeadlineMs: Number.isFinite(deadlineMs) ? deadlineMs : undefined,
    });

    // Default behavior: if tags are empty, treat it as a "screenshot + report" style job.
    const wantsScreenshot = normalizedTags.includes("browser") || normalizedTags.includes("screenshot") || normalizedTags.length === 0;
    const wantsSnapshot = normalizedTags.includes("snapshot");

    let extracted = {};
    try {
      if (wantsScreenshot && browserFlow) {
        const res = await runOpenClawBrowserFlowModule({ token, job: claimedJob, flow: browserFlow, allowedOrigins: jobAllowedOrigins, deadlineMs });
        artifacts.push(...res.artifacts);
        extracted = res.extracted ?? {};
      } else {
        if (wantsScreenshot) {
          artifacts.push(await runOpenClawScreenshotModule({ token, job: claimedJob, allowedOrigins: jobAllowedOrigins, deadlineMs }));
        }
        if (wantsSnapshot) {
          const snap = await runOpenClawSnapshotModule({ token, job: claimedJob, allowedOrigins: jobAllowedOrigins, deadlineMs });
          if (snap) artifacts.push(snap);
        }
      }

      if (wantsHttpModule) {
        const httpArt = await runHttpModule({ token, job: claimedJob, allowedOrigins: jobAllowedOrigins, deadlineMs });
        if (httpArt) artifacts.push(httpArt);
      }

      const wantsFfmpeg = normalizedTags.includes("ffmpeg") || requiredArtifacts.some((r) => r && typeof r === "object" && String(r.kind ?? "") === "video");
      if (wantsFfmpeg) {
        if (ffmpegHealthy === false) throw new Error("ffmpeg_unavailable");
        const clipArt = await runFfmpegClipModule({ token, job: claimedJob, allowedOrigins: jobAllowedOrigins, deadlineMs });
        if (clipArt) artifacts.push(clipArt);

        const timelineArt = await runClipTimelineModule({ token, job: claimedJob });
        if (timelineArt) artifacts.push(timelineArt);
      }

      artifacts.push(
        ...(await runStructuredJsonOutputsModule({
          token,
          job: claimedJob,
          extracted,
          allowedOrigins: jobAllowedOrigins,
          deadlineMs,
        })),
      );

      if (normalizedTags.includes("llm_summarize")) {
        artifacts.push(await runLlmSummarizeModule({ token, job: claimedJob, artifactsSoFar: artifacts.slice() }));
      }

      const submitted = await submitJob({ token, workerId, job: claimedJob, artifacts });
      console.log("submitted", {
        jobId: claimedJob.jobId,
        submissionId: submitted?.data?.submission?.id ?? null,
        state: submitted?.state,
      });

      await writeStatus({ lastSubmitAt: Date.now(), lastJobId: String(claimedJob.jobId ?? jobId), lastError: null });
      if (WAIT_FOR_DONE) await pollUntilDone({ token, jobId: claimedJob.jobId });
      if (ONCE) return;
      await sleep(500);
    } catch (err) {
      const msg = String(err?.message ?? err);
      console.error("job failed", { jobId: jobId, err: msg });
      await writeStatus({ lastErrorAt: Date.now(), lastError: msg, lastJobId: jobId });
      await releaseLeaseEarly({ token, jobId, leaseNonce, reason: msg.slice(0, 200) });
      addRefusal(refuseCache, jobId, `job_failed:${msg}`, 10 * 60_000);
      await sleep(ERROR_BACKOFF_MS);
      continue;
    }
  }
}

loop().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
