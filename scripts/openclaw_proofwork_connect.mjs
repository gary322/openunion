#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

function parseArgs(argv) {
  const out = {
    apiBaseUrl: "",
    // "auto" means:
    // - if running inside the repo, install the local extension dir
    // - otherwise, shallow-clone the repo and install from that path
    pluginSpec: "auto",
    repoUrl: String(process.env.PROOFWORK_CONNECT_REPO_URL ?? "https://github.com/gary322/openunion.git"),
    repoRef: String(process.env.PROOFWORK_CONNECT_REPO_REF ?? "main"),
    openclawBin: "openclaw",
    browserProfile: "proofwork-worker",
    canaryPercent: undefined,
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
    if (a === "--repoUrl" || a === "--repo-url") {
      out.repoUrl = String(argv[i + 1] ?? out.repoUrl);
      i += 1;
      continue;
    }
    if (a === "--repoRef" || a === "--repo-ref" || a === "--ref") {
      out.repoRef = String(argv[i + 1] ?? out.repoRef);
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
  out.repoUrl = String(out.repoUrl ?? "").trim();
  out.repoRef = String(out.repoRef ?? "").trim();
  out.openclawBin = String(out.openclawBin ?? "").trim() || "openclaw";
  out.browserProfile = String(out.browserProfile ?? "").trim() || "proofwork-worker";
  return out;
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

async function runCommandReal(cmd, args, opts = {}) {
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

async function runSysCommand(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
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

function findLocalPluginDir() {
  try {
    const self = fileURLToPath(import.meta.url);
    // scripts/openclaw_proofwork_connect.mjs -> repoRoot
    const repoRoot = path.resolve(path.dirname(self), "..");
    const pluginDir = path.join(repoRoot, "integrations", "openclaw", "extensions", "proofwork-worker");
    const manifest = path.join(pluginDir, "openclaw.plugin.json");
    if (fs.existsSync(manifest)) return pluginDir;
    return null;
  } catch {
    return null;
  }
}

async function resolvePluginSpecAuto(input, deps = {}) {
  const log = deps.log ?? (() => {});
  const local = findLocalPluginDir();
  if (local) return { pluginSpec: local, cleanup: null };

  const repoUrl = String(input.repoUrl || "").trim();
  const repoRef = String(input.repoRef || "").trim() || "main";
  if (!repoUrl) {
    throw new Error("auto_plugin_requires_repoUrl");
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), "proofwork-connect-"));
  log(`[connect] cloning ${repoUrl}#${repoRef} -> ${tmp}`);
  const clone = await runSysCommand("git", ["clone", "--depth", "1", "--branch", repoRef, repoUrl, tmp], { timeoutMs: 5 * 60_000 });
  if (clone.code !== 0) {
    const msg = String(clone.stderr || clone.stdout || "").trim().slice(0, 4000);
    throw new Error(`git_clone_failed:${repoUrl}#${repoRef}${msg ? `\n${msg}` : ""}`);
  }

  const pluginDir = path.join(tmp, "integrations", "openclaw", "extensions", "proofwork-worker");
  const manifest = path.join(pluginDir, "openclaw.plugin.json");
  if (!fs.existsSync(manifest)) {
    throw new Error(`plugin_manifest_not_found_in_repo:${manifest}`);
  }

  const cleanup = async () => {
    try {
      await rm(tmp, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };

  return { pluginSpec: pluginDir, cleanup };
}

async function runConnect(input, deps = {}) {
  const runCommand = deps.runCommand ?? runCommandReal;
  const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`));

  const apiBaseUrl = input.apiBaseUrl;
  if (!apiBaseUrl) throw new Error("--apiBaseUrl is required");

  const openclawBin = input.openclawBin;
  let pluginSpec = String(input.pluginSpec ?? "").trim();
  const browserProfile = input.browserProfile;
  const dryRun = Boolean(input.dryRun);

  const run = async (args, opts = {}) => {
    const printable = [openclawBin, ...args].join(" ");
    if (dryRun) {
      log(`[dry-run] ${printable}`);
      return { code: 0, stdout: "", stderr: "" };
    }
    log(`[run] ${printable}`);
    const res = await runCommand(openclawBin, args, { timeoutMs: opts.timeoutMs ?? 60_000 });
    if (res.code !== 0) {
      const msg = (res.stderr || res.stdout || "").trim().slice(0, 2000);
      throw new Error(`command_failed:${printable}${msg ? `\n${msg}` : ""}`);
    }
    return res;
  };

  // Compatibility gate: require a reasonably recent OpenClaw.
  const v = await run(["--version"], { timeoutMs: 15_000 });
  const parsed = parseOpenClawVersion(v.stdout || v.stderr);
  const min = { year: 2026, minor: 1, patch: 0 };
  if (parsed && compareVersion(parsed, min) < 0) {
    throw new Error(`openclaw_too_old: need >= ${min.year}.${min.minor}.${min.patch} (found ${parsed.year}.${parsed.minor}.${parsed.patch})`);
  }

  let cleanup = null;
  if (!pluginSpec || pluginSpec === "auto") {
    const resolved = await resolvePluginSpecAuto(input, { log });
    pluginSpec = resolved.pluginSpec;
    cleanup = resolved.cleanup;
  }

  // Install or update the plugin.
  await run(["plugins", "install", pluginSpec], { timeoutMs: 5 * 60_000 });

  // Configure + enable the plugin (only apiBaseUrl is required; the rest are safe defaults).
  const cfg = {
    apiBaseUrl,
    openclawBin,
    browserProfile,
    ...(Number.isFinite(input.canaryPercent) ? { canaryPercent: input.canaryPercent } : {}),
  };
  await run(["config", "set", "--json", "plugins.enabled", "true"]);
  await run(["config", "set", "--json", "plugins.entries.proofwork-worker.enabled", "true"]);
  await run(["config", "set", "--json", "plugins.entries.proofwork-worker.config", JSON.stringify(cfg)]);

  // Apply config changes.
  await run(["gateway", "restart", "--json"], { timeoutMs: 2 * 60_000 });

  log("");
  log("Connected Proofwork worker to OpenClaw.");
  log("Next:");
  log("- openclaw tui");
  log("- /proofwork status");
  log("- /proofwork payout message 0xYourAddress");
  log("- sign, then /proofwork payout set 0xYourAddress 0xSignature base");

  if (cleanup) {
    await cleanup();
  }
}

export const __internal = { parseArgs, runConnect, runCommandReal, runSysCommand, parseOpenClawVersion, compareVersion, resolvePluginSpecAuto, findLocalPluginDir };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      [
        "Usage:",
        "  node scripts/openclaw_proofwork_connect.mjs --apiBaseUrl https://api.proofwork.xyz [options]",
        "",
        "Options:",
        "  --plugin <auto|path|.tgz|npm-spec>  Plugin to install (default: auto)",
        "  --repoUrl <git-url>                Repo URL used by --plugin auto (default: https://github.com/gary322/openunion.git)",
        "  --repoRef <ref>                    Repo ref used by --plugin auto (default: main)",
        "  --openclaw <bin>                   OpenClaw CLI path (default: openclaw)",
        "  --browserProfile <name>            Dedicated worker browser profile (default: proofwork-worker)",
        "  --canaryPercent <0..100>           Optional canary sampling percent",
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
    return false;
  }
})();

if (isDirect) {
  main().catch((err) => {
    process.stderr.write(String(err?.message ?? err) + "\n");
    process.exit(1);
  });
}
