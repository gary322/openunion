#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const out = {
    apiBaseUrl: "",
    pluginSpec: "@proofwork/proofwork-worker",
    openclawBin: "openclaw",
    browserProfile: "proofwork-worker",
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
    if (a === "--browserProfile" || a === "--browser-profile") {
      out.browserProfile = String(argv[i + 1] ?? out.browserProfile);
      i += 1;
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
  out.browserProfile = String(out.browserProfile ?? "").trim() || "proofwork-worker";
  return out;
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(String(raw ?? "")) ?? null;
  } catch {
    // Try to recover if some tools printed extra lines.
    const s = String(raw ?? "");
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
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

async function waitForWorkerStatusFile(input) {
  const start = Date.now();
  const timeoutMs = Number(input.timeoutMs ?? 25_000);
  const pluginRoot = path.join(input.stateDir, "plugins", "proofwork-worker");

  const expectedHash = input.workspaceDir ? sha256Hex(path.resolve(input.workspaceDir)).slice(0, 12) : sha256Hex("global").slice(0, 12);
  const expected = path.join(pluginRoot, expectedHash, "status.json");

  const candidateStatusFiles = async () => {
    const out = [];
    try {
      if (fs.existsSync(expected)) out.push(expected);
    } catch {
      // ignore
    }
    try {
      const dirs = fs.existsSync(pluginRoot) ? fs.readdirSync(pluginRoot, { withFileTypes: true }) : [];
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const p = path.join(pluginRoot, d.name, "status.json");
        try {
          if (fs.existsSync(p)) out.push(p);
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
        return { statusFile: p, status: json };
      } catch {
        // ignore
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return null;
}

async function ensureGatewayRunning(input, deps = {}) {
  const run = deps.run;
  const runRaw = deps.runRaw;
  const log = deps.log ?? (() => {});

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

  if (needsInstall) {
    log("[connect] gateway service not installed; installing…");
    try {
      await run(["gateway", "install", "--json"], { timeoutMs: 2 * 60_000 });
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

  const restart = await runRaw(["gateway", "restart", "--json"], { timeoutMs: 2 * 60_000 });
  const restartJson = safeJsonParse(restart.stdout || restart.stderr) ?? null;
  if (restartJson?.result === "not-loaded" || restartJson?.service?.loaded === false) {
    log("[connect] gateway service not loaded after restart; installing + starting…");
    try {
      await run(["gateway", "install", "--json"], { timeoutMs: 2 * 60_000 });
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

  // Confirm the gateway is reachable.
  try {
    await run(["health", "--json"], { timeoutMs: 15_000 });
  } catch (err) {
    // As a recovery, attempt a start (in case the daemon is loaded but stopped).
    log("[connect] gateway health check failed; attempting start…");
    try {
      await run(["gateway", "start", "--json"], { timeoutMs: 2 * 60_000 });
      await run(["health", "--json"], { timeoutMs: 15_000 });
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
  const dryRun = Boolean(input.dryRun);

  const runRaw = async (ocArgs, opts = {}) => {
    const printable = [openclawBin, ...ocArgs].join(" ");
    if (dryRun) {
      log(`[dry-run] ${printable}`);
      return { code: 0, stdout: "", stderr: "" };
    }
    log(`[run] ${printable}`);
    const res = await runCommandImpl(openclawBin, ocArgs, { timeoutMs: opts.timeoutMs ?? 60_000 });
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

  await run(["plugins", "install", input.pluginSpec], { timeoutMs: 5 * 60_000 });

  const cfg = {
    apiBaseUrl,
    openclawBin,
    browserProfile: input.browserProfile,
    ...(Number.isFinite(input.canaryPercent) ? { canaryPercent: input.canaryPercent } : {}),
  };
  await run(["config", "set", "--json", "plugins.enabled", "true"]);
  await run(["config", "set", "--json", "plugins.entries.proofwork-worker.enabled", "true"]);
  await run(["config", "set", "--json", "plugins.entries.proofwork-worker.config", JSON.stringify(cfg)]);

  let gatewayStatusJson = null;
  await ensureGatewayRunning(
    {},
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
    });
    if (!status) {
      throw new Error(
        [
          "proofwork_worker_not_running: Gateway is up, but the Proofwork worker did not report status in time.",
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
    const workerId = typeof status.status?.workerId === "string" ? status.status.workerId : "";
    const lastPollAt = typeof status.status?.lastPollAt === "number" ? status.status.lastPollAt : null;
    log("");
    log(`Proofwork worker is running. workerId=${workerId}${lastPollAt ? ` lastPollAt=${new Date(lastPollAt).toISOString()}` : ""}`);
  }

  log("");
  log("Connected Proofwork worker to OpenClaw.");
  log("Next:");
  log("- openclaw tui");
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
  resolveStateDirFromGatewayStatus,
  waitForWorkerStatusFile,
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
        "Options:",
        "  --plugin <path|.tgz|npm-spec>       Plugin to install (default: @proofwork/proofwork-worker)",
        "  --openclaw <bin>                   OpenClaw CLI path (default: openclaw)",
        "  --browserProfile <name>            Dedicated worker browser profile (default: proofwork-worker)",
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
