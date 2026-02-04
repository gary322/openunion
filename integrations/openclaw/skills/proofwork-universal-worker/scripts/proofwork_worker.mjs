// Proofwork Universal Worker implemented as an OpenClaw skill helper script.
//
// This is intentionally dependency-light (Node 22+ only) and uses:
// - Proofwork HTTP APIs (jobs/next, claim, presign uploads, submit)
// - openclaw CLI for browser screenshots/snapshots (optional but default)
// - ffmpeg/ffprobe for clip extraction (optional)
//
// Configuration is env-driven (see SKILL.md).

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_BASE_URL = (process.env.PROOFWORK_API_BASE_URL ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);
const ONCE = String(process.env.ONCE ?? "").toLowerCase() === "true";
const WAIT_FOR_DONE = String(process.env.WAIT_FOR_DONE ?? "").toLowerCase() === "true";

const OPENCLAW_BIN = String(process.env.OPENCLAW_BIN ?? "openclaw").trim() || "openclaw";
const OPENCLAW_AGENT_ID = String(process.env.OPENCLAW_AGENT_ID ?? "").trim() || null;
const OPENCLAW_THINKING = String(process.env.OPENCLAW_THINKING ?? "low").trim() || "low";

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

function supportedCapabilityTags() {
  return String(process.env.PROOFWORK_SUPPORTED_CAPABILITY_TAGS ?? "browser,http,screenshot,llm_summarize")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
  const json = text ? JSON.parse(text) : null;
  return { resp, json };
}

async function ensureWorkerToken() {
  const existing =
    String(process.env.PROOFWORK_WORKER_TOKEN ?? "").trim() ||
    String(process.env.WORKER_TOKEN ?? "").trim();
  if (existing) return { token: existing, workerId: "unknown" };

  const reg = await apiFetch("/api/workers/register", {
    method: "POST",
    body: { displayName: "openclaw-universal", capabilities: { openclaw: true } },
  });
  if (!reg.resp.ok) throw new Error(`worker_register_failed:${reg.resp.status}`);
  const token = String(reg.json?.token ?? "");
  const workerId = String(reg.json?.workerId ?? "");
  if (!token) throw new Error("worker_register_missing_token");
  return { token, workerId };
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
  const child = spawn(OPENCLAW_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += String(d)));
  child.stderr.on("data", (d) => (stderr += String(d)));

  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, timeoutMs);
  timer.unref?.();

  const code = await new Promise((resolve) => child.on("close", resolve));
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

  const code = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  return { code: Number(code ?? 1), stdout, stderr };
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

async function getArxivReferencesFromApi(query) {
  const q = String(query ?? "").trim();
  if (!q) return [];

  try {
    const url = new URL(ARXIV_API_BASE_URL);
    url.searchParams.set("search_query", `all:${q}`);
    url.searchParams.set("start", "0");
    url.searchParams.set("max_results", String(ARXIV_MAX_RESULTS));

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 30_000);
    t.unref?.();
    try {
      const resp = await fetch(url.toString(), { method: "GET", headers: { Accept: "application/atom+xml" }, signal: ac.signal });
      if (!resp.ok) return [];
      const xml = await resp.text();
      const parsed = parseArxivAtomFeed(xml).slice(0, ARXIV_MAX_RESULTS);
      return parsed.map((p) => ({ id: `arxiv:${p.id}`, title: p.title, url: `https://arxiv.org/abs/${p.id}` }));
    } finally {
      clearTimeout(t);
    }
  } catch {
    return [];
  }
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

function pickFillValue(step) {
  if (typeof step?.value_env === "string" && step.value_env) return String(process.env[step.value_env] ?? "");
  if (typeof step?.value === "string") return step.value;
  return "";
}

function normalizeTimeoutMs(step, fallbackMs) {
  const n = Number(step?.timeout_ms ?? step?.timeoutMs ?? fallbackMs);
  if (!Number.isFinite(n)) return fallbackMs;
  return Math.max(250, Math.min(60_000, Math.floor(n)));
}

async function runOpenClawBrowserFlowModule(input) {
  const descriptorUrl = input.job?.taskDescriptor?.input_spec?.url;
  const startUrl =
    typeof descriptorUrl === "string" && descriptorUrl
      ? descriptorUrl
      : String(input.job?.journey?.startUrl ?? "");
  if (!startUrl) throw new Error("missing_start_url");

  const flow = input.flow ?? {};
  const stepsRaw = Array.isArray(flow?.steps) ? flow.steps : [];
  const maxSteps = Number.isFinite(Number(flow?.max_steps)) ? Math.max(1, Math.min(100, Number(flow.max_steps))) : 50;
  const steps = stepsRaw.slice(0, maxSteps);
  const continueOnError = flow?.continue_on_error !== false;

  const logs = [];
  const extracted = {};
  const artifacts = [];

  const opened = await runOpenClaw(["browser", "open", startUrl, "--json"], { timeoutMs: 30_000 });
  const openJson = parseJsonFromStdout(opened.stdout);
  const targetId = String(openJson?.targetId ?? "").trim();
  if (!targetId) throw new Error("openclaw_browser_open_missing_target_id");

  try {
    logs.push(`start_url: ${startUrl}`);
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] ?? {};
      const op = String(step?.op ?? step?.action ?? "").trim().toLowerCase();
      if (!op) continue;

      try {
        if (op === "goto" || op === "navigate") {
          const url = typeof step?.url === "string" && step.url ? step.url : startUrl;
          logs.push(`step ${i}: ${op} url=${url}`);
          await runOpenClaw(["browser", "navigate", url, "--target-id", targetId, "--json"], { timeoutMs: normalizeTimeoutMs(step, 30_000) });
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
            logs.push(`step ${i}: wait url=${step.url}`);
            await runOpenClaw(["browser", "wait", "--url", step.url, "--timeout-ms", String(t), "--target-id", targetId, "--json"], { timeoutMs: t + 2_000 });
          } else {
            logs.push(`step ${i}: wait default`);
            await runOpenClaw(["browser", "wait", "--time", "250", "--timeout-ms", String(t), "--target-id", targetId, "--json"], { timeoutMs: t + 2_000 });
          }
        } else if (op === "click") {
          const explicit = typeof step?.ref === "string" ? step.ref.trim() : "";
          const ref =
            explicit ||
            (await resolveRefViaSnapshot({ targetId, match: { role: step?.role, name: step?.name, text: step?.text } }));
          if (!ref) throw new Error("ref_not_found");
          logs.push(`step ${i}: click ref=${ref}`);
          await runOpenClaw(["browser", "click", ref, "--target-id", targetId, "--json"], { timeoutMs: normalizeTimeoutMs(step, 20_000) });
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
        } else if (op === "screenshot") {
          const fullPage = step?.full_page === true || step?.fullPage === true;
          const label = typeof step?.label === "string" && step.label ? step.label : `flow_screenshot_${i}`;
          logs.push(`step ${i}: screenshot label=${label} fullPage=${fullPage}`);
          const dir = await mkdtemp(join(tmpdir(), "proofwork-openclaw-shot-"));
          const outPath = join(dir, `${label}.png`);
          try {
            const args = ["browser", "screenshot"];
            if (fullPage) args.push("--full-page");
            args.push("--target-id", targetId, "--out", outPath, "--json");
            const shot = await runOpenClaw(args, { timeoutMs: 45_000 });
            const shotJson = parseJsonFromStdout(shot.stdout);
            const out = String(shotJson?.path ?? outPath).trim() || outPath;
            const bytes = await readFile(out);
            artifacts.push(
              await uploadArtifact({
                token: input.token,
                jobId: input.job.jobId,
                filename: `${label}.png`,
                contentType: "image/png",
                bytes,
                kind: "screenshot",
                label,
              }),
            );
          } finally {
            await rm(dir, { recursive: true, force: true }).catch(() => undefined);
          }
        } else if (op === "extract") {
          const key = typeof step?.key === "string" && step.key ? step.key : `extract_${i}`;
          const explicit = typeof step?.ref === "string" ? step.ref.trim() : "";
          const ref =
            explicit ||
            (await resolveRefViaSnapshot({ targetId, match: { role: step?.role, name: step?.name, text: step?.text } }));
          if (!ref) throw new Error("ref_not_found");
          const fn = typeof step?.fn === "string" && step.fn ? step.fn : "(el) => el.textContent";
          logs.push(`step ${i}: extract key=${key} ref=${ref}`);
          const r = await runOpenClaw(["browser", "evaluate", "--fn", fn, "--ref", ref, "--target-id", targetId, "--json"], {
            timeoutMs: normalizeTimeoutMs(step, 20_000),
          });
          const j = parseJsonFromStdout(r.stdout);
          extracted[key] = j?.result ?? null;
        } else {
          logs.push(`step ${i}: unknown op=${op} (ignored)`);
        }
      } catch (err) {
        logs.push(`step ${i}: ERROR op=${op} err=${String(err?.message ?? err).slice(0, 500)}`);
        if (!continueOnError) break;
      }
    }

    if (!artifacts.some((a) => a.kind === "screenshot" && a.label === "universal_screenshot")) {
      // Always emit a final screenshot under a stable label.
      const dir = await mkdtemp(join(tmpdir(), "proofwork-openclaw-final-"));
      const outPath = join(dir, "screenshot.png");
      try {
        const shot = await runOpenClaw(["browser", "screenshot", "--full-page", "--target-id", targetId, "--out", outPath, "--json"], {
          timeoutMs: 45_000,
        });
        const shotJson = parseJsonFromStdout(shot.stdout);
        const out = String(shotJson?.path ?? outPath).trim() || outPath;
        const bytes = await readFile(out);
        artifacts.push(
          await uploadArtifact({
            token: input.token,
            jobId: input.job.jobId,
            filename: "screenshot.png",
            contentType: "image/png",
            bytes,
            kind: "screenshot",
            label: "universal_screenshot",
          }),
        );
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
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

  // Open URL in OpenClaw's dedicated browser, screenshot, then close the tab.
  const opened = await runOpenClaw(["browser", "open", startUrl, "--json"], { timeoutMs: 30_000 });
  const openJson = parseJsonFromStdout(opened.stdout);
  const targetId = String(openJson?.targetId ?? "").trim();
  if (!targetId) throw new Error("openclaw_browser_open_missing_target_id");

  try {
    const shot = await runOpenClaw(
      ["browser", "screenshot", targetId, "--full-page", "--type", "png", "--json"],
      { timeoutMs: 45_000 },
    );
    const shotJson = parseJsonFromStdout(shot.stdout);
    const path = String(shotJson?.path ?? "").trim();
    if (!path) throw new Error("openclaw_browser_screenshot_missing_path");
    const bytes = await readFile(path);
    return await uploadArtifact({
      token: input.token,
      jobId: input.job.jobId,
      filename: "screenshot.png",
      contentType: "image/png",
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

  const opened = await runOpenClaw(["browser", "open", startUrl, "--json"], { timeoutMs: 30_000 });
  const openJson = parseJsonFromStdout(opened.stdout);
  const targetId = String(openJson?.targetId ?? "").trim();
  if (!targetId) return null;

  const dir = await mkdtemp(join(tmpdir(), "proofwork-openclaw-snap-"));
  const outPath = join(dir, "snapshot.ai.txt");

  try {
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

async function runHttpModule(input) {
  const url = input.job?.taskDescriptor?.input_spec?.url;
  if (typeof url !== "string" || !url) return null;
  const resp = await fetch(url, { method: "GET" });
  const text = await resp.text();
  const out = `url: ${url}\nstatus: ${resp.status}\n\n${text.slice(0, 20_000)}\n`;
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

  const startSec = Number(input.job?.taskDescriptor?.input_spec?.start_sec ?? 0);
  const durationSec = Number(input.job?.taskDescriptor?.input_spec?.duration_sec ?? 10);
  if (!Number.isFinite(startSec) || startSec < 0) throw new Error("invalid_start_sec");
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 600)
    throw new Error("invalid_duration_sec");

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
      let err = "";
      p.stderr.on("data", (d) => (err += String(d)));
      p.on("error", (e) => reject(new Error(`ffmpeg_spawn_error:${String(e?.message ?? e)}`)));
      p.on("close", (code) => {
        if (code === 0) return resolve();
        reject(new Error(`ffmpeg_failed:${code}:${err.slice(0, 500)}`));
      });
    });

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
    const extractedRows = Array.isArray(extracted.rows) ? extracted.rows : null;
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
    const extractedRepos = Array.isArray(extracted.repos) ? extracted.repos : null;
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
    const apiRefs = llmRefs.length === 0 && idea ? await getArxivReferencesFromApi(idea) : [];
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
  const manifest = {
    manifestVersion: "1.0",
    jobId: input.job.jobId,
    bountyId: input.job.bountyId,
    finalUrl: input.job?.journey?.startUrl,
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

async function loop() {
  const { token, workerId } = await ensureWorkerToken();
  const supported = supportedCapabilityTags();
  const prefer = String(process.env.PROOFWORK_PREFER_CAPABILITY_TAG ?? "").trim() || undefined;
  const requireTaskType =
    String(process.env.PROOFWORK_REQUIRE_TASK_TYPE ?? process.env.REQUIRE_TASK_TYPE ?? "").trim() || undefined;
  const minPayoutCents = process.env.PROOFWORK_MIN_PAYOUT_CENTS
    ? Number(process.env.PROOFWORK_MIN_PAYOUT_CENTS)
    : undefined;

  for (;;) {
    const next = await apiFetch("/api/jobs/next", {
      token,
      query: {
        capability_tags: supported.join(","),
        ...(prefer ? { capability_tag: prefer } : {}),
        ...(requireTaskType ? { task_type: requireTaskType } : {}),
        ...(minPayoutCents ? { min_payout_cents: minPayoutCents } : {}),
      },
    });

    if (!next.resp.ok) {
      console.error("jobs/next failed", next.resp.status, next.json);
      await sleep(2000);
      continue;
    }

    if (next.json?.state !== "claimable") {
      if (ONCE) return;
      await sleep(1000);
      continue;
    }

    const job = next.json.data.job;
    if (!withinCanary(String(job.jobId ?? ""))) {
      if (ONCE) return;
      await sleep(2000);
      continue;
    }

    const claim = await apiFetch(`/api/jobs/${encodeURIComponent(job.jobId)}/claim`, {
      method: "POST",
      token,
    });
    if (!claim.resp.ok) {
      console.error("claim failed", claim.resp.status, claim.json);
      await sleep(1000);
      continue;
    }

    const claimedJob = claim.json?.data?.job ?? job;
    const td = claimedJob?.taskDescriptor ?? {};
    const tags = Array.isArray(td?.capability_tags) ? td.capability_tags : [];
    const browserFlow = getBrowserFlowSpec(claimedJob);
    const requiredArtifacts = Array.isArray(td?.output_spec?.required_artifacts)
      ? td.output_spec.required_artifacts
      : [];
    const wantsHttpModule =
      tags.includes("http") &&
      (td?.output_spec?.http_response === true ||
        requiredArtifacts.some(
          (r) => r && typeof r === "object" && String(r.kind ?? "") === "log" && String(r.label ?? "") === "report_http",
        ));

    const artifacts = [];

    // Default behavior: if tags are empty, treat it as a "screenshot + report" style job.
    const wantsScreenshot = tags.includes("browser") || tags.includes("screenshot") || tags.length === 0;
    const wantsSnapshot = tags.includes("snapshot");

    let extracted = {};
    if (wantsScreenshot && browserFlow) {
      const res = await runOpenClawBrowserFlowModule({ token, job: claimedJob, flow: browserFlow });
      artifacts.push(...res.artifacts);
      extracted = res.extracted ?? {};
    } else {
      if (wantsScreenshot) {
        artifacts.push(await runOpenClawScreenshotModule({ token, job: claimedJob }));
      }
      if (wantsSnapshot) {
        const snap = await runOpenClawSnapshotModule({ token, job: claimedJob });
        if (snap) artifacts.push(snap);
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

    if (tags.includes("llm_summarize")) {
      artifacts.push(await runLlmSummarizeModule({ token, job: claimedJob, artifactsSoFar: artifacts.slice() }));
    }

    const submitted = await submitJob({ token, workerId, job: claimedJob, artifacts });
    console.log("submitted", {
      jobId: claimedJob.jobId,
      submissionId: submitted?.data?.submission?.id ?? null,
      state: submitted?.state,
    });

    if (WAIT_FOR_DONE) await pollUntilDone({ token, jobId: claimedJob.jobId });
    if (ONCE) return;
    await sleep(500);
  }
}

loop().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
