#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const out = {
    apiBaseUrl: "",
    pluginSpec: "@proofwork/proofwork-worker",
    openclawBin: "openclaw",
    openclawProfile: "",
    browserProfile: "proofwork-worker",
    preset: "app-suite",
    canaryPercent: undefined,
    healthCheck: true,
    doctor: false,
    waitForWorkerMs: 25_000,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apiBaseUrl" || a === "--api-base-url") {
      out.apiBaseUrl = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (a === "--plugin" || a === "--pluginSpec" || a === "--plugin-spec") {
      out.pluginSpec = String(argv[i + 1] ?? out.pluginSpec);
      i += 1;
      continue;
    }
    if (a === "--openclaw" || a === "--openclawBin" || a === "--openclaw-bin") {
      out.openclawBin = String(argv[i + 1] ?? out.openclawBin);
      i += 1;
      continue;
    }
    if (a === "--openclawProfile" || a === "--openclaw-profile") {
      out.openclawProfile = String(argv[i + 1] ?? out.openclawProfile);
      i += 1;
      continue;
    }
    if (a === "--browserProfile" || a === "--browser-profile") {
      out.browserProfile = String(argv[i + 1] ?? out.browserProfile);
      i += 1;
      continue;
    }
    if (a === "--preset") {
      out.preset = String(argv[i + 1] ?? out.preset);
      i += 1;
      continue;
    }
    if (a === "--single") {
      out.preset = "single";
      continue;
    }
    if (a === "--canaryPercent" || a === "--canary-percent") {
      const n = Number(argv[i + 1]);
      out.canaryPercent = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.floor(n))) : undefined;
      i += 1;
      continue;
    }
    if (a === "--health-check") {
      out.healthCheck = true;
      continue;
    }
    if (a === "--no-health-check" || a === "--skip-health-check") {
      out.healthCheck = false;
      continue;
    }
    if (a === "--doctor") {
      out.doctor = true;
      continue;
    }
    if (a === "--waitForWorkerMs" || a === "--wait-for-worker-ms") {
      const n = Number(argv[i + 1]);
      out.waitForWorkerMs = Number.isFinite(n) ? Math.max(1_000, Math.min(120_000, Math.floor(n))) : out.waitForWorkerMs;
      i += 1;
      continue;
    }
    if (a === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
  }

  out.apiBaseUrl = String(out.apiBaseUrl ?? "").trim().replace(/\/$/, "");
  out.pluginSpec = String(out.pluginSpec ?? "").trim();
  out.openclawBin = String(out.openclawBin ?? "").trim() || "openclaw";
  out.openclawProfile = String(out.openclawProfile ?? "").trim();
  out.browserProfile = String(out.browserProfile ?? "").trim() || "proofwork-worker";
  out.preset = String(out.preset ?? "").trim() || "app-suite";
  return out;
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(String(raw ?? "")) ?? null;
  } catch {
    // Try to recover if some tools printed extra lines (e.g. config warnings).
    const s = String(raw ?? "");
    const start = s.search(/[\[{]/);
    const endObj = s.lastIndexOf("}");
    const endArr = s.lastIndexOf("]");
    const end = Math.max(endObj, endArr);
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1)) ?? null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function sha256Hex(input) {
  return createHash("sha256").update(String(input)).digest("hex");
}

function sanitizeWorkerKey(name) {
  const base = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const h = sha256Hex(String(name ?? "")).slice(0, 6);
  const out = base ? `${base}-${h}` : h;
  return out.slice(0, 40) || h;
}

function parseOpenClawVersion(raw) {
  const s = String(raw ?? "").trim();
  const m = s.match(/(\d{4})\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { year: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function compareVersion(a, b) {
  if (a.year !== b.year) return a.year - b.year;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function looksLikeNpmSpec(spec) {
  const s = String(spec ?? "").trim();
  return !!s && !s.startsWith("/") && !s.startsWith(".") && !s.endsWith(".tgz") && !s.endsWith(".tar.gz");
}

async function runCommand(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += String(d)));
  child.stderr.on("data", (d) => (stderr += String(d)));

  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, timeoutMs);
  timer.unref?.();

  const code = await new Promise((resolve) => {
    child.on("close", resolve);
    child.on("error", () => resolve(1));
  });
  clearTimeout(timer);

  return { code: Number(code ?? 1), stdout, stderr };
}

function resolveStateDirFromGatewayStatus(statusJson) {
  const cliPath = statusJson?.config?.cli?.path;
  if (typeof cliPath === "string" && cliPath.trim()) return path.dirname(cliPath.trim());
  const envDir = String(process.env.OPENCLAW_STATE_DIR ?? "").trim();
  if (envDir) return envDir;
  return path.join(os.homedir(), ".openclaw");
}

function extractGatewayPort(statusJson) {
  const candidates = [
    statusJson?.gateway?.port,
    statusJson?.rpc?.port,
    statusJson?.port?.port,
    statusJson?.service?.command?.environment?.OPENCLAW_GATEWAY_PORT,
    statusJson?.service?.command?.environment?.CLAWDBOT_GATEWAY_PORT,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
    if (typeof c === "string" && c.trim()) {
      const m = Number.parseInt(c.trim(), 10);
      if (Number.isFinite(m) && m > 0) return m;
    }
  }
  return null;
}

function randomGatewayToken() {
  // OpenClaw gateway auth token: generated and stored in the OpenClaw config for the selected profile.
  // Must not be printed to stdout/stderr.
  return randomBytes(32).toString("hex");
}

async function isPortFree(port) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref?.();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function pickFreePort(preferredPort) {
  const preferred = Number(preferredPort);
  if (Number.isFinite(preferred) && preferred > 0) {
    const ok = await isPortFree(preferred);
    if (ok) return Math.floor(preferred);
  }

  // Ask the OS for an ephemeral free port.
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref?.();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : null;
      server.close(() => {
        if (!port) return reject(new Error("failed_to_pick_port"));
        resolve(Number(port));
      });
    });
  });
}

async function ensureGatewayConfigured(input, deps = {}) {
  const run = deps.run;
  const runRaw = deps.runRaw;
  const log = deps.log ?? (() => {});

  // gateway.mode must be set on a fresh OpenClaw profile (OpenClaw refuses to start the daemon otherwise).
  let gatewayMode = null;
  try {
    const raw = await runRaw(["config", "get", "--json", "gateway.mode"], { timeoutMs: 10_000 });
    gatewayMode = safeJsonParse(raw.stdout || raw.stderr);
  } catch {
    // ignore
  }
  if (typeof gatewayMode !== "string" || !gatewayMode.trim()) {
    log("[connect] configuring gateway.mode=local (fresh profile) …");
    await run(["config", "set", "--json", "gateway.mode", JSON.stringify("local")], { timeoutMs: 15_000 });
  }

  // Ensure gateway.auth.mode and gateway.auth.token exist. OpenClaw defaults to token auth on many installs.
  let authMode = null;
  try {
    const raw = await runRaw(["config", "get", "--json", "gateway.auth.mode"], { timeoutMs: 10_000 });
    authMode = safeJsonParse(raw.stdout || raw.stderr);
  } catch {
    // ignore
  }
  if (typeof authMode !== "string" || !authMode.trim()) {
    await run(["config", "set", "--json", "gateway.auth.mode", JSON.stringify("token")], { timeoutMs: 15_000 });
    authMode = "token";
  }

  if (String(authMode).trim() === "token") {
    let token = null;
    try {
      const raw = await runRaw(["config", "get", "--json", "gateway.auth.token"], { timeoutMs: 10_000 });
      token = safeJsonParse(raw.stdout || raw.stderr);
    } catch {
      // ignore
    }
    const existingToken = typeof token === "string" && token.trim() ? token.trim() : "";
    if (!existingToken) {
      log("[connect] configuring gateway.auth.token (fresh profile) …");
      const newToken = randomGatewayToken();
      await run(["config", "set", "--json", "gateway.auth.token", JSON.stringify(newToken)], { timeoutMs: 15_000 });
      // OpenClaw CLI connects using gateway.remote.token; keep it in sync with gateway.auth.token.
      await run(["config", "set", "--json", "gateway.remote.token", JSON.stringify(newToken)], { timeoutMs: 15_000 });
      return;
    }

    // Ensure the CLI-side remote token matches the gateway auth token. This is required for
    // `openclaw health` and other CLI calls to connect after we bootstrap gateway.auth.token.
    let remoteToken = null;
    try {
      const raw = await runRaw(["config", "get", "--json", "gateway.remote.token"], { timeoutMs: 10_000 });
      remoteToken = safeJsonParse(raw.stdout || raw.stderr);
    } catch {
      // ignore
    }
    const remoteTokenStr = typeof remoteToken === "string" ? remoteToken.trim() : "";
    if (!remoteTokenStr || remoteTokenStr !== existingToken) {
      log("[connect] syncing gateway.remote.token to gateway.auth.token …");
      await run(["config", "set", "--json", "gateway.remote.token", JSON.stringify(existingToken)], { timeoutMs: 15_000 });
    }
  }
}

async function waitForWorkerStatusFile(input) {
  const start = Date.now();
  const timeoutMs = Number(input.timeoutMs ?? 25_000);
  const maxAgeMs = Number(input.maxAgeMs ?? 30_000);
  const pluginRoot = path.join(input.stateDir, "plugins", "proofwork-worker");

  const expectedHash = input.workspaceDir ? sha256Hex(path.resolve(input.workspaceDir)).slice(0, 12) : sha256Hex("global").slice(0, 12);
  const expectedDir = path.join(pluginRoot, expectedHash);

  const candidateStatusFiles = async () => {
    const out = [];
    try {
      if (fs.existsSync(expectedDir)) {
        const entries = fs.readdirSync(expectedDir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isFile()) continue;
          if (!e.name.startsWith("status")) continue;
          if (!e.name.endsWith(".json")) continue;
          out.push(path.join(expectedDir, e.name));
        }
      }
    } catch {
      // ignore
    }
    try {
      const dirs = fs.existsSync(pluginRoot) ? fs.readdirSync(pluginRoot, { withFileTypes: true }) : [];
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const dir = path.join(pluginRoot, d.name);
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            if (!e.isFile()) continue;
            if (!e.name.startsWith("status")) continue;
            if (!e.name.endsWith(".json")) continue;
            out.push(path.join(dir, e.name));
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    // Deduplicate.
    return Array.from(new Set(out));
  };

  while (Date.now() - start < timeoutMs) {
    const candidates = await candidateStatusFiles();
    for (const p of candidates) {
      try {
        const raw = fs.readFileSync(p, "utf8");
        const json = safeJsonParse(raw);
        const workerId = typeof json?.workerId === "string" ? json.workerId : "";
        if (!workerId) continue;
        if (json?.paused === true) continue;
        const lastPollAt = typeof json?.lastPollAt === "number" ? json.lastPollAt : null;
        if (!lastPollAt) continue;
        if (Date.now() - lastPollAt > maxAgeMs) continue;
        return { statusFile: p, status: json };
      } catch {
        // ignore
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return null;
}

async function waitForWorkerStatusFiles(input) {
  const start = Date.now();
  const timeoutMs = Number(input.timeoutMs ?? 25_000);
  const maxAgeMs = Number(input.maxAgeMs ?? 30_000);

  const pluginRoot = path.join(input.stateDir, "plugins", "proofwork-worker");
  const expectedHash = input.workspaceDir
    ? sha256Hex(path.resolve(input.workspaceDir)).slice(0, 12)
    : sha256Hex("global").slice(0, 12);
  const expectedDir = path.join(pluginRoot, expectedHash);

  const names = Array.isArray(input.workerNames) ? input.workerNames.map((n) => String(n ?? "").trim()).filter(Boolean) : [];
  const expectedFiles = names.length
    ? names.map((n) => ({ name: n, path: path.join(expectedDir, `status.${sanitizeWorkerKey(n)}.json`) }))
    : [];

  if (!expectedFiles.length) {
    // Fallback to "any one" mode.
    const one = await waitForWorkerStatusFile({ ...input, timeoutMs, maxAgeMs });
    return one ? { statuses: { default: one } } : null;
  }

  while (Date.now() - start < timeoutMs) {
    const out = {};
    let okCount = 0;

    for (const exp of expectedFiles) {
      try {
        if (!fs.existsSync(exp.path)) continue;
        const raw = fs.readFileSync(exp.path, "utf8");
        const json = safeJsonParse(raw);
        const workerId = typeof json?.workerId === "string" ? json.workerId : "";
        if (!workerId) continue;
        if (json?.paused === true) continue;
        const lastPollAt = typeof json?.lastPollAt === "number" ? json.lastPollAt : null;
        if (!lastPollAt) continue;
        if (Date.now() - lastPollAt > maxAgeMs) continue;
        out[exp.name] = { statusFile: exp.path, status: json };
        okCount += 1;
      } catch {
        // ignore
      }
    }

    if (okCount === expectedFiles.length) return { statuses: out, workspaceHash: expectedHash, statusDir: expectedDir };
    await new Promise((r) => setTimeout(r, 250));
  }

  const missing = expectedFiles
    .map((e) => e.name)
    .filter((n) => {
      try {
        const p = path.join(expectedDir, `status.${sanitizeWorkerKey(n)}.json`);
        if (!fs.existsSync(p)) return true;
        const raw = fs.readFileSync(p, "utf8");
        const json = safeJsonParse(raw);
        const lastPollAt = typeof json?.lastPollAt === "number" ? json.lastPollAt : 0;
        return !lastPollAt || Date.now() - lastPollAt > maxAgeMs;
      } catch {
        return true;
      }
    });

  return { error: { code: "status_timeout", missingWorkers: missing, statusDir: expectedDir, workspaceHash: expectedHash } };
}

function loadPathsContainProofworkWorker(loadPaths) {
  if (!Array.isArray(loadPaths)) return null;
  for (const p of loadPaths) {
    const dir = typeof p === "string" ? p.trim() : "";
    if (!dir) continue;
    try {
      const manifestPath = path.join(dir, "openclaw.plugin.json");
      if (!fs.existsSync(manifestPath)) continue;
      const raw = fs.readFileSync(manifestPath, "utf8");
      const j = safeJsonParse(raw);
      if (j?.id === "proofwork-worker") return dir;
    } catch {
      // ignore
    }
  }
  return null;
}

async function ensureGatewayRunning(input, deps = {}) {
  const run = deps.run;
  const runRaw = deps.runRaw;
  const log = deps.log ?? (() => {});
  const openclawProfile = typeof input?.openclawProfile === "string" ? input.openclawProfile.trim() : "";

  // Detect "not loaded" gateway service and install it automatically. This is the most common
  // failure mode on fresh OpenClaw installs: `openclaw gateway restart` returns ok=true but
  // result=not-loaded (no daemon installed), and the worker never starts.
  let statusJson = null;
  try {
    const s = await runRaw(["gateway", "status", "--json"], { timeoutMs: 20_000 });
    statusJson = safeJsonParse(s.stdout || s.stderr) ?? null;
  } catch {
    // ignore (we'll rely on restart)
  }

  const needsInstall =
    statusJson?.service?.loaded === false ||
    statusJson?.service?.runtime?.missingUnit === true;

  const portConflict =
    statusJson?.service?.loaded === true &&
    statusJson?.port?.status === "busy" &&
    (statusJson?.service?.runtime?.status ?? "") !== "running" &&
    Array.isArray(statusJson?.port?.listeners) &&
    statusJson.port.listeners.length > 0;

  // If the caller requested an isolated profile and the default port is already in use (e.g. the
  // user's main OpenClaw gateway is running), pick a free port and install/reinstall the profile's
  // gateway service there.
  if (openclawProfile && portConflict) {
    const port = await pickFreePort(extractGatewayPort(statusJson) ?? 18789);
    log(`[connect] gateway port is busy; reinstalling profile gateway on port ${port} …`);
    await run(["gateway", "install", "--json", "--force", "--port", String(port)], { timeoutMs: 2 * 60_000 });
    await run(["config", "set", "--json", "gateway.port", String(port)], { timeoutMs: 15_000 });
  }

  if (needsInstall) {
    log("[connect] gateway service not installed; installing…");
    const installArgs = ["gateway", "install", "--json"];
    if (openclawProfile) {
      const port = await pickFreePort(18789);
      installArgs.push("--port", String(port));
      await run(["config", "set", "--json", "gateway.port", String(port)], { timeoutMs: 15_000 });
    }
    try {
      await run(installArgs, { timeoutMs: 2 * 60_000 });
    } catch (err) {
      throw new Error(
        [
          "openclaw_gateway_install_failed",
          String(err?.message ?? err),
          "",
          "Try:",
          "- openclaw gateway install --force",
          "- openclaw gateway start",
          "",
          "If this is a fresh install and the gateway still won't start:",
          "- openclaw onboard --non-interactive --accept-risk --auth-choice skip --install-daemon --skip-channels --skip-skills --skip-ui",
        ].join("\n")
      );
    }
  }

  // Fresh profiles often require gateway config bootstrapping before the daemon can start.
  // (OpenClaw refuses to start until gateway.mode and gateway.auth.token are set.)
  try {
    await ensureGatewayConfigured(input, { run, runRaw, log });
  } catch (err) {
    // If we can't configure the gateway, we can still try to restart/start; but log a hint.
    log(`[connect] gateway config bootstrap failed (continuing): ${String(err?.message ?? err)}`);
  }

  const restart = await runRaw(["gateway", "restart", "--json"], { timeoutMs: 2 * 60_000 });
  const restartJson = safeJsonParse(restart.stdout || restart.stderr) ?? null;
  if (restartJson?.result === "not-loaded" || restartJson?.service?.loaded === false) {
    log("[connect] gateway service not loaded after restart; installing + starting…");
    try {
      const installArgs = ["gateway", "install", "--json"];
      if (openclawProfile) {
        const port = await pickFreePort(18789);
        installArgs.push("--port", String(port));
        await run(["config", "set", "--json", "gateway.port", String(port)], { timeoutMs: 15_000 });
      }
      await run(installArgs, { timeoutMs: 2 * 60_000 });
      await run(["gateway", "start", "--json"], { timeoutMs: 2 * 60_000 });
    } catch (err) {
      throw new Error(
        [
          "openclaw_gateway_start_failed",
          String(err?.message ?? err),
          "",
          "Try:",
          "- openclaw gateway status --json",
          "- openclaw gateway install",
          "- openclaw gateway start",
          "- openclaw logs gateway",
        ].join("\n")
      );
    }
  }

  // Ensure CLI config matches the running gateway port. On many installs the gateway service
  // runs on a non-default port, but fresh configs default to 18789. The `openclaw health` command
  // does not accept --url, so we must set gateway.port to the service port for health checks to work.
  try {
    const s3 = await runRaw(["gateway", "status", "--json"], { timeoutMs: 20_000 });
    const j3 = safeJsonParse(s3.stdout || s3.stderr) ?? null;
    const port = extractGatewayPort(j3);
    if (port) {
      await run(["config", "set", "--json", "gateway.port", String(port)], { timeoutMs: 15_000 });
    }
  } catch {
    // ignore (best-effort)
  }

  // Confirm the gateway is reachable.
  const waitForHealth = async () => {
    const deadline = Date.now() + 25_000;
    let lastErr = null;
    while (Date.now() < deadline) {
      try {
        await run(["health", "--json"], { timeoutMs: 15_000 });
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw lastErr ?? new Error("health_failed");
  };

  try {
    await waitForHealth();
  } catch (err) {
    // As a recovery, attempt to bootstrap config and then start (in case the daemon is blocked).
    log("[connect] gateway health check failed; attempting config bootstrap + start…");
    try {
      await ensureGatewayConfigured(input, { run, runRaw, log });
    } catch {
      // ignore (best-effort)
    }
    try {
      await run(["gateway", "start", "--json"], { timeoutMs: 2 * 60_000 });
      await waitForHealth();
    } catch (err2) {
      throw new Error(
        [
          "openclaw_gateway_unreachable",
          String(err2?.message ?? err2),
          "",
          "Try:",
          "- openclaw gateway status --json",
          "- openclaw gateway restart --json",
          "- openclaw doctor --non-interactive",
        ].join("\n")
      );
    }
  }

  // Return a fresh status payload (includes config paths + state dir hints).
  try {
    const s2 = await runRaw(["gateway", "status", "--json"], { timeoutMs: 20_000 });
    const j2 = safeJsonParse(s2.stdout || s2.stderr) ?? null;
    if (j2) return j2;
  } catch {
    // ignore
  }

  return restartJson ?? statusJson;
}

async function runConnect(input, deps = {}) {
  const runCommandImpl = deps.runCommand ?? runCommand;
  const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`));

  const apiBaseUrl = input.apiBaseUrl;
  if (!apiBaseUrl) throw new Error("--apiBaseUrl is required");

  const openclawBin = input.openclawBin;
  const openclawProfile = String(input.openclawProfile ?? "").trim();
  const dryRun = Boolean(input.dryRun);

  const runRaw = async (ocArgs, opts = {}) => {
    const fullArgs = openclawProfile ? ["--profile", openclawProfile, ...ocArgs] : ocArgs;
    const printableArgs = [...fullArgs];
    // Redact secrets from logs (connect should never print auth tokens).
    const cmdIdx = printableArgs[0] === "--profile" ? 2 : 0;
    if (printableArgs[cmdIdx] === "config" && printableArgs[cmdIdx + 1] === "set") {
      const key = String(printableArgs[cmdIdx + 3] ?? "");
      if (key && /token|secret|password/i.test(key)) {
        if (printableArgs.length >= cmdIdx + 5) printableArgs[cmdIdx + 4] = JSON.stringify("[redacted]");
      }
    }
    const printable = [openclawBin, ...printableArgs].join(" ");
    if (dryRun) {
      log(`[dry-run] ${printable}`);
      return { code: 0, stdout: "", stderr: "" };
    }
    log(`[run] ${printable}`);
    const res = await runCommandImpl(openclawBin, fullArgs, { timeoutMs: opts.timeoutMs ?? 60_000 });
    if (res.code !== 0) {
      const msg = (res.stderr || res.stdout || "").trim().slice(0, 2000);
      throw new Error(`command_failed:${printable}${msg ? `\n${msg}` : ""}`);
    }
    return res;
  };

  const run = async (ocArgs, opts = {}) => {
    const res = await runRaw(ocArgs, opts);
    return res;
  };

  const v = await run(["--version"], { timeoutMs: 15_000 });
  const parsed = parseOpenClawVersion(v.stdout || v.stderr);
  const min = { year: 2026, minor: 1, patch: 0 };
  if (parsed && compareVersion(parsed, min) < 0) {
    throw new Error(`openclaw_too_old: need >= ${min.year}.${min.minor}.${min.patch} (found ${parsed.year}.${parsed.minor}.${parsed.patch})`);
  }

  // Avoid duplicate plugin IDs in dev setups where the monorepo plugin is already loaded by path.
  let skipInstall = false;
  try {
    const raw = await runRaw(["config", "get", "--json", "plugins.load.paths"], { timeoutMs: 10_000 });
    const loadPaths = safeJsonParse(raw.stdout || raw.stderr);
    const proofworkPath = loadPathsContainProofworkWorker(loadPaths);
    if (proofworkPath && input.pluginSpec === "@proofwork/proofwork-worker" && looksLikeNpmSpec(input.pluginSpec)) {
      skipInstall = true;
      log(`[connect] proofwork-worker already loaded via plugins.load.paths (${proofworkPath}); skipping install to avoid duplicate plugin ids.`);
    }
  } catch {
    // ignore
  }
  if (!skipInstall) {
    await run(["plugins", "install", input.pluginSpec], { timeoutMs: 5 * 60_000 });
  }

  const cfg = {
    apiBaseUrl,
    openclawBin,
    browserProfile: input.browserProfile,
    workerDisplayName: os.hostname(),
    ...(Number.isFinite(input.canaryPercent) ? { canaryPercent: input.canaryPercent } : {}),
  };
  const preset = String(input.preset ?? "app-suite").trim().toLowerCase();
  if (preset !== "single") {
    cfg.workers = [
      {
        name: "jobs",
        enabled: true,
        allowTaskTypes: ["jobs_scrape"],
        supportedCapabilityTags: ["browser", "screenshot", "http", "llm_summarize"],
      },
      {
        name: "research",
        enabled: true,
        allowTaskTypes: ["arxiv_research_plan"],
        supportedCapabilityTags: ["http", "llm_summarize"],
      },
      {
        name: "github",
        enabled: true,
        allowTaskTypes: ["github_scan"],
        supportedCapabilityTags: ["http", "llm_summarize"],
      },
      {
        name: "marketplace",
        enabled: true,
        allowTaskTypes: ["marketplace_drops"],
        supportedCapabilityTags: ["browser", "screenshot"],
      },
      {
        name: "clips",
        enabled: true,
        allowTaskTypes: ["clips_highlights"],
        supportedCapabilityTags: ["ffmpeg", "llm_summarize"],
      },
    ];
  }
  await run(["config", "set", "--json", "plugins.enabled", "true"]);
  await run(["config", "set", "--json", "plugins.entries.proofwork-worker.enabled", "true"]);
  await run(["config", "set", "--json", "plugins.entries.proofwork-worker.config", JSON.stringify(cfg)]);

  let gatewayStatusJson = null;
  await ensureGatewayRunning(
    { openclawProfile },
    {
      run,
      runRaw,
      log,
    }
  ).then((j) => {
    gatewayStatusJson = j;
  });

  if (input.healthCheck && !dryRun) {
    // Optionally run OpenClaw's own doctor (non-interactive) for extra diagnostics.
    if (input.doctor) {
      try {
        const d = await runRaw(["doctor", "--non-interactive"], { timeoutMs: 60_000 });
        const out = String(d.stdout || d.stderr || "").trim();
        if (out) log(out);
      } catch {
        // ignore
      }
    }

    // Find the gateway state dir and wait for the proofwork worker status file to appear.
    let stateDir = resolveStateDirFromGatewayStatus(gatewayStatusJson);
    let workspaceDir = null;
    try {
      const ws = await runRaw(["config", "get", "--json", "agents.defaults.workspace"], { timeoutMs: 10_000 });
      const parsedWs = safeJsonParse(ws.stdout || ws.stderr);
      if (typeof parsedWs === "string" && parsedWs.trim()) workspaceDir = parsedWs.trim();
    } catch {
      // ignore
    }

    const status = await waitForWorkerStatusFile({
      stateDir,
      workspaceDir,
      timeoutMs: input.waitForWorkerMs,
      maxAgeMs: 30_000,
    });
    const workerNames = Array.isArray(cfg.workers) ? cfg.workers.map((w) => w?.name).filter(Boolean) : [];
    const multi = preset !== "single";
    const statuses = multi
      ? await waitForWorkerStatusFiles({
          stateDir,
          workspaceDir,
          workerNames,
          timeoutMs: input.waitForWorkerMs,
          maxAgeMs: 30_000,
        })
      : status
        ? { statuses: { default: status } }
        : null;

    if (!statuses || statuses?.error) {
      const missing = statuses?.error?.missingWorkers?.length ? `\nMissing workers: ${statuses.error.missingWorkers.join(", ")}` : "";
      throw new Error(
        [
          "proofwork_worker_not_running: Gateway is up, but the Proofwork worker did not report status in time.",
          missing,
          "",
          "Try:",
          "- openclaw tui",
          "- /proofwork status",
          "",
          "If the gateway is still not running, run:",
          "- openclaw gateway status --json",
          "- openclaw gateway install",
          "- openclaw gateway start",
        ].join("\n")
      );
    }
    const lines = [];
    const renderOne = (name, st) => {
      const workerId = typeof st?.workerId === "string" ? st.workerId : "";
      const lastPollAt = typeof st?.lastPollAt === "number" ? st.lastPollAt : null;
      const browserReady = typeof st?.browserReady === "boolean" ? st.browserReady : null;
      const lastBrowserError = typeof st?.lastBrowserError === "string" ? st.lastBrowserError : "";
      const ffmpegReady = typeof st?.ffmpegReady === "boolean" ? st.ffmpegReady : null;
      const lastFfmpegError = typeof st?.lastFfmpegError === "string" ? st.lastFfmpegError : "";
      const effective = Array.isArray(st?.effectiveCapabilityTags) ? st.effectiveCapabilityTags.map(String).filter(Boolean) : [];

      lines.push(
        `- ${name}: workerId=${workerId || "(unknown)"}${lastPollAt ? ` lastPollAt=${new Date(lastPollAt).toISOString()}` : ""}`
      );
      if (effective.length) lines.push(`  effectiveCapabilityTags: ${effective.join(",")}`);
      if (browserReady === false) lines.push(`  browserReady=false (${lastBrowserError || "browser_unhealthy"})`);
      if (ffmpegReady === false) lines.push(`  ffmpegReady=false (${lastFfmpegError || "ffmpeg_unhealthy"})`);
    };

    log("");
    if (multi) {
      log("Proofwork workers are running:");
      for (const name of workerNames) {
        const st = statuses.statuses?.[name]?.status;
        if (st) renderOne(name, st);
      }
      if (lines.length) log(lines.join("\n"));
    } else {
      const only = statuses.statuses?.default?.status;
      log(`Proofwork worker is running.${only?.workerId ? ` workerId=${only.workerId}` : ""}`);
      if (only) renderOne("default", only);
      if (lines.length) log(lines.join("\n"));
    }

    // Post-setup warnings for common missing prerequisites.
    const warnBrowser = multi
      ? workerNames.some((name) => statuses.statuses?.[name]?.status?.browserReady === false)
      : statuses.statuses?.default?.status?.browserReady === false;
    const warnFfmpeg = multi
      ? workerNames.some((name) => statuses.statuses?.[name]?.status?.ffmpegReady === false)
      : statuses.statuses?.default?.status?.ffmpegReady === false;
    if (warnBrowser) {
      log("");
      log("Warning: browser automation is not ready on this machine. Jobs/Marketplace tasks require a supported local browser.");
      log("Install Chrome/Brave/Edge/Chromium, then restart the OpenClaw Gateway:");
      log(`- openclaw${openclawProfile ? ` --profile ${openclawProfile}` : ""} gateway restart`);
    }
    if (warnFfmpeg) {
      log("");
      log("Warning: ffmpeg is not available. Clips tasks require ffmpeg on the worker machine.");
      log("Install ffmpeg and restart the OpenClaw Gateway.");
    }

    const first = multi ? statuses.statuses?.[workerNames[0]]?.status : statuses.statuses?.default?.status;
    const workerId = typeof first?.workerId === "string" ? first.workerId : "";
    const lastPollAt = typeof first?.lastPollAt === "number" ? first.lastPollAt : null;
    log("");
    if (workerId) {
      log(`Worker status ok. workerId=${workerId}${lastPollAt ? ` lastPollAt=${new Date(lastPollAt).toISOString()}` : ""}`);
    }
  }

  log("");
  log("Connected Proofwork worker to OpenClaw.");
  log("Next:");
  log(`- openclaw${openclawProfile ? ` --profile ${openclawProfile}` : ""} tui`);
  log("- /proofwork status");
  log("- /proofwork payout message 0xYourAddress");
}

export const __internal = {
  parseArgs,
  parseOpenClawVersion,
  compareVersion,
  runCommand,
  safeJsonParse,
  sha256Hex,
  sanitizeWorkerKey,
  resolveStateDirFromGatewayStatus,
  waitForWorkerStatusFile,
  waitForWorkerStatusFiles,
  ensureGatewayRunning,
  runConnect,
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      [
        "Usage:",
        "  npx --yes @proofwork/proofwork-worker --apiBaseUrl https://api.proofwork.xyz",
        "",
        "Or (explicit bin):",
        "  npx --yes -p @proofwork/proofwork-worker proofwork-connect --apiBaseUrl https://api.proofwork.xyz",
        "",
        "Defaults:",
        "  --preset app-suite  (configures multiple specialized workers: jobs, research, github, marketplace, clips)",
        "",
        "Options:",
        "  --plugin <path|.tgz|npm-spec>       Plugin to install (default: @proofwork/proofwork-worker)",
        "  --openclaw <bin>                   OpenClaw CLI path (default: openclaw)",
        "  --openclawProfile <name>           Use an isolated OpenClaw profile (~/.openclaw-<name>)",
        "  --browserProfile <name>            Dedicated worker browser profile (default: proofwork-worker)",
        "  --preset <app-suite|single>        Configure a multi-worker preset (default: app-suite)",
        "  --single                           Alias for --preset single",
        "  --canaryPercent <0..100>           Optional canary sampling percent",
        "  --no-health-check                  Skip post-setup health checks (gateway + worker status file)",
        "  --doctor                           Print OpenClaw doctor output (non-interactive)",
        "  --waitForWorkerMs <ms>             Wait time for worker status file (default: 25000, max: 120000)",
        "  --dry-run                          Print commands without executing",
      ].join("\n") + "\n"
    );
    process.exit(0);
  }

  await runConnect(args);
}

const isDirect = (() => {
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const invoked = process.argv[1] ? fs.realpathSync(path.resolve(process.argv[1])) : "";
    return invoked && invoked === self;
  } catch {
    return true;
  }
})();

if (isDirect) {
  main().catch((err) => {
    process.stderr.write(String(err?.message ?? err) + "\n");
    process.exit(1);
  });
}
