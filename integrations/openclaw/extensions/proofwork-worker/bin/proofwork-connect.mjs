#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const out = {
    apiBaseUrl: "",
    pluginSpec: "@proofwork/proofwork-worker",
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
        "  --dry-run                          Print commands without executing",
      ].join("\n") + "\n"
    );
    process.exit(0);
  }

  const apiBaseUrl = args.apiBaseUrl;
  if (!apiBaseUrl) throw new Error("--apiBaseUrl is required");

  const log = (s) => process.stdout.write(`${s}\n`);
  const openclawBin = args.openclawBin;
  const dryRun = Boolean(args.dryRun);

  const run = async (ocArgs, opts = {}) => {
    const printable = [openclawBin, ...ocArgs].join(" ");
    if (dryRun) {
      log(`[dry-run] ${printable}`);
      return { code: 0, stdout: "", stderr: "" };
    }
    log(`[run] ${printable}`);
    const res = await runCommand(openclawBin, ocArgs, { timeoutMs: opts.timeoutMs ?? 60_000 });
    if (res.code !== 0) {
      const msg = (res.stderr || res.stdout || "").trim().slice(0, 2000);
      throw new Error(`command_failed:${printable}${msg ? `\n${msg}` : ""}`);
    }
    return res;
  };

  const v = await run(["--version"], { timeoutMs: 15_000 });
  const parsed = parseOpenClawVersion(v.stdout || v.stderr);
  const min = { year: 2026, minor: 1, patch: 0 };
  if (parsed && compareVersion(parsed, min) < 0) {
    throw new Error(`openclaw_too_old: need >= ${min.year}.${min.minor}.${min.patch} (found ${parsed.year}.${parsed.minor}.${parsed.patch})`);
  }

  await run(["plugins", "install", args.pluginSpec], { timeoutMs: 5 * 60_000 });

  const cfg = {
    apiBaseUrl,
    openclawBin,
    browserProfile: args.browserProfile,
    ...(Number.isFinite(args.canaryPercent) ? { canaryPercent: args.canaryPercent } : {}),
  };
  await run(["config", "set", "--json", "plugins.enabled", "true"]);
  await run(["config", "set", "--json", "plugins.entries.proofwork-worker.enabled", "true"]);
  await run(["config", "set", "--json", "plugins.entries.proofwork-worker.config", JSON.stringify(cfg)]);

  await run(["gateway", "restart", "--json"], { timeoutMs: 2 * 60_000 });

  log("");
  log("Connected Proofwork worker to OpenClaw.");
  log("Next:");
  log("- openclaw tui");
  log("- /proofwork status");
  log("- /proofwork payout message 0xYourAddress");
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
