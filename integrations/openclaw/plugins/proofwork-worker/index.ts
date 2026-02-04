import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type PluginLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
};

type PluginServiceContext = {
  config: Record<string, unknown>;
  workspaceDir?: string;
  stateDir: string;
  logger: PluginLogger;
};

type PluginApi = {
  id: string;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  registerService: (service: {
    id: string;
    start: (ctx: PluginServiceContext) => void | Promise<void>;
    stop?: (ctx: PluginServiceContext) => void | Promise<void>;
  }) => void;
  registerCommand: (cmd: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (ctx: {
      args?: string;
      commandBody?: string;
      channel?: string;
      senderId?: string;
      isAuthorizedSender?: boolean;
      config?: Record<string, unknown>;
    }) => { text: string } | Promise<{ text: string }>;
  }) => void;
};

type ProofworkPluginConfig = {
  apiBaseUrl: string;
  enabled: boolean;
  autoStart: boolean;
  browserProfile: string;
  resetBrowserProfileOnStart: boolean;
  supportedCapabilityTags: string[];
  minPayoutCents?: number;
  preferCapabilityTag?: string;
  requireTaskType?: string;
  canaryPercent: number;
  pollIntervalMs: number;
  originEnforcement: "strict" | "off";
  noLogin: boolean;
  valueEnvAllowlist: string[];
  extraAllowedOrigins: string[];
  jobTimeBudgetSec?: number;
  httpMaxBytes: number;
  artifactMaxBytes?: number;
  ffmpegMaxDurationSec: number;
  logLevel: "info" | "debug";
  allowTaskTypes: string[];
  denyTaskTypes: string[];
  allowOrigins: string[];
  denyOrigins: string[];
  openclawBin: string;
  workerScriptPath?: string;
  dangerouslyEnableOpenclawAgentSummarize: boolean;
};

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function readTextIfExists(p: string): string | null {
  try {
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

function writeFileAtomic(p: string, data: string, mode?: number) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, p);
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function unlinkIfExists(p: string) {
  try {
    fs.unlinkSync(p);
  } catch {
    // ignore
  }
}

function parseConfig(raw: Record<string, unknown> | undefined): ProofworkPluginConfig {
  const cfg = raw ?? {};
  const apiBaseUrl = typeof cfg.apiBaseUrl === "string" ? cfg.apiBaseUrl.trim().replace(/\/$/, "") : "";
  if (!apiBaseUrl) throw new Error("plugins.entries.proofwork-worker.config.apiBaseUrl is required");

  const enabled = typeof cfg.enabled === "boolean" ? cfg.enabled : true;
  const autoStart = typeof cfg.autoStart === "boolean" ? cfg.autoStart : true;
  const browserProfile =
    typeof cfg.browserProfile === "string" && cfg.browserProfile.trim()
      ? cfg.browserProfile.trim()
      : "proofwork-worker";
  const resetBrowserProfileOnStart =
    typeof cfg.resetBrowserProfileOnStart === "boolean" ? cfg.resetBrowserProfileOnStart : false;

  const supportedCapabilityTags = Array.isArray(cfg.supportedCapabilityTags)
    ? cfg.supportedCapabilityTags.map((t) => String(t).trim()).filter(Boolean)
    : ["browser", "screenshot", "http", "llm_summarize"];
  if (supportedCapabilityTags.length === 0) {
    throw new Error("supportedCapabilityTags must not be empty");
  }

  const minPayoutCents = cfg.minPayoutCents === undefined ? undefined : Number(cfg.minPayoutCents);
  const preferCapabilityTag =
    typeof cfg.preferCapabilityTag === "string" && cfg.preferCapabilityTag.trim()
      ? cfg.preferCapabilityTag.trim()
      : undefined;
  const requireTaskType =
    typeof cfg.requireTaskType === "string" && cfg.requireTaskType.trim()
      ? cfg.requireTaskType.trim()
      : undefined;
  const canaryPercentRaw = Number(cfg.canaryPercent ?? 100);
  const canaryPercent = Number.isFinite(canaryPercentRaw)
    ? Math.max(0, Math.min(100, Math.floor(canaryPercentRaw)))
    : 100;

  const pollIntervalMsRaw = Number(cfg.pollIntervalMs ?? 1000);
  const pollIntervalMs = Number.isFinite(pollIntervalMsRaw)
    ? Math.max(250, Math.min(60_000, Math.floor(pollIntervalMsRaw)))
    : 1000;

  const originEnforcement = cfg.originEnforcement === "off" ? "off" : "strict";
  const noLogin = typeof cfg.noLogin === "boolean" ? cfg.noLogin : true;
  const valueEnvAllowlist = Array.isArray(cfg.valueEnvAllowlist)
    ? cfg.valueEnvAllowlist.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const extraAllowedOrigins = Array.isArray(cfg.extraAllowedOrigins)
    ? cfg.extraAllowedOrigins.map((s) => String(s).trim()).filter(Boolean)
    : [];

  const jobTimeBudgetSecRaw = cfg.jobTimeBudgetSec === undefined ? undefined : Number(cfg.jobTimeBudgetSec);
  const jobTimeBudgetSec =
    jobTimeBudgetSecRaw === undefined
      ? undefined
      : Number.isFinite(jobTimeBudgetSecRaw)
        ? Math.max(10, Math.min(3600, Math.floor(jobTimeBudgetSecRaw)))
        : undefined;

  const httpMaxBytesRaw = Number(cfg.httpMaxBytes ?? 2_000_000);
  const httpMaxBytes = Number.isFinite(httpMaxBytesRaw)
    ? Math.max(1024, Math.min(50_000_000, Math.floor(httpMaxBytesRaw)))
    : 2_000_000;

  const artifactMaxBytesRaw = cfg.artifactMaxBytes === undefined ? undefined : Number(cfg.artifactMaxBytes);
  const artifactMaxBytes =
    artifactMaxBytesRaw === undefined
      ? undefined
      : Number.isFinite(artifactMaxBytesRaw)
        ? Math.max(1024, Math.min(500_000_000, Math.floor(artifactMaxBytesRaw)))
        : undefined;

  const ffmpegMaxDurationSecRaw = Number(cfg.ffmpegMaxDurationSec ?? 60);
  const ffmpegMaxDurationSec = Number.isFinite(ffmpegMaxDurationSecRaw)
    ? Math.max(1, Math.min(600, Math.floor(ffmpegMaxDurationSecRaw)))
    : 60;

  const logLevel = cfg.logLevel === "debug" ? "debug" : "info";
  const allowTaskTypes = Array.isArray(cfg.allowTaskTypes)
    ? cfg.allowTaskTypes.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const denyTaskTypes = Array.isArray(cfg.denyTaskTypes)
    ? cfg.denyTaskTypes.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const allowOrigins = Array.isArray(cfg.allowOrigins)
    ? cfg.allowOrigins.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const denyOrigins = Array.isArray(cfg.denyOrigins)
    ? cfg.denyOrigins.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const openclawBin =
    typeof cfg.openclawBin === "string" && cfg.openclawBin.trim() ? cfg.openclawBin.trim() : "openclaw";
  const workerScriptPath =
    typeof cfg.workerScriptPath === "string" && cfg.workerScriptPath.trim() ? cfg.workerScriptPath.trim() : undefined;
  const dangerouslyEnableOpenclawAgentSummarize =
    typeof cfg.dangerouslyEnableOpenclawAgentSummarize === "boolean"
      ? cfg.dangerouslyEnableOpenclawAgentSummarize
      : false;

  return {
    apiBaseUrl,
    enabled,
    autoStart,
    browserProfile,
    resetBrowserProfileOnStart,
    supportedCapabilityTags,
    minPayoutCents,
    preferCapabilityTag,
    requireTaskType,
    canaryPercent,
    pollIntervalMs,
    originEnforcement,
    noLogin,
    valueEnvAllowlist,
    extraAllowedOrigins,
    jobTimeBudgetSec,
    httpMaxBytes,
    artifactMaxBytes,
    ffmpegMaxDurationSec,
    logLevel,
    allowTaskTypes,
    denyTaskTypes,
    allowOrigins,
    denyOrigins,
    openclawBin,
    workerScriptPath,
    dangerouslyEnableOpenclawAgentSummarize,
  };
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function redactEnvForLogs(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!v) continue;
    if (/token|secret|password|key/i.test(k)) out[k] = "<redacted>";
    else out[k] = v.length > 200 ? `${v.slice(0, 200)}…` : v;
  }
  return out;
}

function parseArgsCsv(s: string | undefined): string[] {
  return String(s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function computeStateRoot(params: { stateDir: string; workspaceDir?: string }): { root: string; workspaceHash: string } {
  const workspaceKey = params.workspaceDir ? path.resolve(params.workspaceDir) : "global";
  const workspaceHash = sha256Hex(workspaceKey).slice(0, 12);
  const root = path.join(params.stateDir, "plugins", "proofwork-worker", workspaceHash);
  return { root, workspaceHash };
}

function buildWorkerEnv(params: {
  baseEnv: NodeJS.ProcessEnv;
  cfg: ProofworkPluginConfig;
  tokenFile: string;
  pauseFile: string;
  statusFile: string;
  stateDir: string;
}) {
  const base: Record<string, string> = {};
  const passthrough = [
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "WINDIR",
    "LOCALAPPDATA",
    "APPDATA",
    "USERPROFILE",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_GATEWAY_URL",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_PASSWORD",
    "OPENCLAW_NIX_MODE",
  ];
  for (const k of passthrough) {
    const v = params.baseEnv[k];
    if (typeof v === "string" && v) base[k] = v;
  }

  // Ensure the worker uses the same OpenClaw state dir as the Gateway.
  base.OPENCLAW_STATE_DIR = params.stateDir;

  base.OPENCLAW_BIN = params.cfg.openclawBin;
  base.OPENCLAW_BROWSER_PROFILE = params.cfg.browserProfile;

  base.PROOFWORK_API_BASE_URL = params.cfg.apiBaseUrl;
  base.PROOFWORK_SUPPORTED_CAPABILITY_TAGS = params.cfg.supportedCapabilityTags.join(",");
  if (Number.isFinite(params.cfg.minPayoutCents as any)) base.PROOFWORK_MIN_PAYOUT_CENTS = String(params.cfg.minPayoutCents);
  if (params.cfg.preferCapabilityTag) base.PROOFWORK_PREFER_CAPABILITY_TAG = params.cfg.preferCapabilityTag;
  if (params.cfg.requireTaskType) base.PROOFWORK_REQUIRE_TASK_TYPE = params.cfg.requireTaskType;
  base.PROOFWORK_CANARY_PERCENT = String(params.cfg.canaryPercent);
  base.PROOFWORK_POLL_INTERVAL_MS = String(params.cfg.pollIntervalMs);
  base.PROOFWORK_ORIGIN_ENFORCEMENT = params.cfg.originEnforcement;
  base.PROOFWORK_NO_LOGIN = params.cfg.noLogin ? "true" : "false";
  if (params.cfg.valueEnvAllowlist.length) base.PROOFWORK_VALUE_ENV_ALLOWLIST = params.cfg.valueEnvAllowlist.join(",");
  if (params.cfg.extraAllowedOrigins.length) base.PROOFWORK_EXTRA_ALLOWED_ORIGINS = params.cfg.extraAllowedOrigins.join(",");
  if (params.cfg.jobTimeBudgetSec) base.PROOFWORK_JOB_TIME_BUDGET_SEC = String(params.cfg.jobTimeBudgetSec);
  base.PROOFWORK_HTTP_MAX_BYTES = String(params.cfg.httpMaxBytes);
  if (params.cfg.artifactMaxBytes) base.PROOFWORK_ARTIFACT_MAX_BYTES = String(params.cfg.artifactMaxBytes);
  base.PROOFWORK_FFMPEG_MAX_DURATION_SEC = String(params.cfg.ffmpegMaxDurationSec);

  base.PROOFWORK_WORKER_TOKEN_FILE = params.tokenFile;
  base.PROOFWORK_PAUSE_FILE = params.pauseFile;
  base.PROOFWORK_STATUS_FILE = params.statusFile;
  base.PROOFWORK_LOG_LEVEL = params.cfg.logLevel;

  if (params.cfg.allowTaskTypes.length) base.PROOFWORK_ALLOW_TASK_TYPES = params.cfg.allowTaskTypes.join(",");
  if (params.cfg.denyTaskTypes.length) base.PROOFWORK_DENY_TASK_TYPES = params.cfg.denyTaskTypes.join(",");
  if (params.cfg.allowOrigins.length) base.PROOFWORK_ALLOW_ORIGINS = params.cfg.allowOrigins.join(",");
  if (params.cfg.denyOrigins.length) base.PROOFWORK_DENY_ORIGINS = params.cfg.denyOrigins.join(",");

  base.PROOFWORK_DANGEROUS_ENABLE_OPENCLAW_AGENT_SUMMARIZE = params.cfg.dangerouslyEnableOpenclawAgentSummarize
    ? "true"
    : "false";

  return base;
}

function resolveWorkerScriptPath(): string {
  // Plugin root: integrations/openclaw/plugins/proofwork-worker
  // Worker script: integrations/openclaw/skills/proofwork-universal-worker/scripts/proofwork_worker.mjs
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "../../skills/proofwork-universal-worker/scripts/proofwork_worker.mjs");
}

export const __internal = {
  parseConfig,
  computeStateRoot,
  buildWorkerEnv,
  resolveWorkerScriptPath,
  isPidAlive,
  redactEnvForLogs,
  parseArgsCsv,
};

export default {
  id: "proofwork-worker",
  name: "Proofwork Worker",
  description: "Runs a Proofwork universal worker loop in the background.",
  register(api: PluginApi) {
    let child: ChildProcessWithoutNullStreams | null = null;
    let stopping = false;
    let restartTimer: NodeJS.Timeout | null = null;
    let restartAttempt = 0;

    let lastCtx: PluginServiceContext | null = null;
    let cfg: ProofworkPluginConfig | null = null;

    const getPaths = (ctx: PluginServiceContext) => {
      const { root, workspaceHash } = computeStateRoot({ stateDir: ctx.stateDir, workspaceDir: ctx.workspaceDir });
      const tokenFile = path.join(root, "worker-token.json");
      const pauseFile = path.join(root, "pause.flag");
      const lockFile = path.join(root, "lock.json");
      const statusFile = path.join(root, "status.json");
      return { root, workspaceHash, tokenFile, pauseFile, lockFile, statusFile };
    };

    const isPaused = (pauseFile: string) => exists(pauseFile);

    const stopChild = async (ctx: PluginServiceContext) => {
      stopping = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (!child) return;
      const pid = child.pid;
      ctx.logger.info(`[proofwork-worker] stopping child pid=${pid}`);

      const killWithTimeout = async () => {
        if (!child) return;
        const start = Date.now();
        try {
          if (process.platform !== "win32") {
            // Best-effort kill the process group when detached.
            try {
              process.kill(-pid, "SIGTERM");
            } catch {
              child.kill("SIGTERM");
            }
          } else {
            child.kill("SIGTERM");
          }
        } catch {
          // ignore
        }
        while (Date.now() - start < 5000) {
          if (!child || child.killed) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        try {
          if (child && !child.killed) {
            if (process.platform !== "win32") {
              try {
                process.kill(-pid, "SIGKILL");
              } catch {
                child.kill("SIGKILL");
              }
            } else {
              child.kill("SIGKILL");
            }
          }
        } catch {
          // ignore
        }
      };

      await killWithTimeout();
      child = null;
    };

    const acquireLockOrThrow = (ctx: PluginServiceContext, lockFile: string) => {
      const raw = readTextIfExists(lockFile);
      if (raw) {
        const j = safeJsonParse<{ pid?: number; startedAt?: number }>(raw);
        const pid = Number(j?.pid ?? 0);
        if (isPidAlive(pid)) {
          throw new Error(`already_running(pid=${pid})`);
        }
      }
      const lock = { pid: process.pid, startedAt: Date.now(), hostname: os.hostname() };
      writeFileAtomic(lockFile, JSON.stringify(lock, null, 2) + "\n", 0o600);
    };

    const spawnWorker = (ctx: PluginServiceContext) => {
      if (!cfg) throw new Error("missing_config");
      const paths = getPaths(ctx);
      fs.mkdirSync(paths.root, { recursive: true });
      if (isPaused(paths.pauseFile)) {
        ctx.logger.info("[proofwork-worker] paused; not starting");
        return;
      }
      acquireLockOrThrow(ctx, paths.lockFile);

      const scriptPath = cfg.workerScriptPath ? path.resolve(cfg.workerScriptPath) : resolveWorkerScriptPath();
      if (!exists(scriptPath)) {
        throw new Error(`worker_script_not_found:${scriptPath}`);
      }

      const env = buildWorkerEnv({
        baseEnv: process.env,
        cfg,
        tokenFile: paths.tokenFile,
        pauseFile: paths.pauseFile,
        statusFile: paths.statusFile,
        stateDir: ctx.stateDir,
      });

      ctx.logger.info(
        `[proofwork-worker] spawning node=${process.execPath} script=${scriptPath} env=${JSON.stringify(
          redactEnvForLogs(env),
        )}`,
      );

      const proc = spawn(process.execPath, [scriptPath], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      child = proc;
      stopping = false;

      const onLine = (line: string, kind: "stdout" | "stderr") => {
        const s = line.trimEnd();
        if (!s) return;
        if (kind === "stderr") ctx.logger.warn(`[proofwork-worker] ${s}`);
        else ctx.logger.info(`[proofwork-worker] ${s}`);
      };

      let bufOut = "";
      proc.stdout.on("data", (d) => {
        bufOut += String(d);
        for (;;) {
          const idx = bufOut.indexOf("\n");
          if (idx === -1) break;
          const line = bufOut.slice(0, idx);
          bufOut = bufOut.slice(idx + 1);
          onLine(line, "stdout");
        }
      });
      let bufErr = "";
      proc.stderr.on("data", (d) => {
        bufErr += String(d);
        for (;;) {
          const idx = bufErr.indexOf("\n");
          if (idx === -1) break;
          const line = bufErr.slice(0, idx);
          bufErr = bufErr.slice(idx + 1);
          onLine(line, "stderr");
        }
      });

      proc.on("close", (code, signal) => {
        const pathsNow = getPaths(ctx);
        unlinkIfExists(pathsNow.lockFile);

        child = null;
        if (stopping) return;

        ctx.logger.warn(`[proofwork-worker] child exited code=${code} signal=${signal ?? ""}`);
        if (isPaused(pathsNow.pauseFile)) {
          ctx.logger.info("[proofwork-worker] paused after exit; not restarting");
          return;
        }

        restartAttempt += 1;
        const base = Math.min(60_000, 1000 * Math.pow(2, Math.min(6, restartAttempt)));
        const jitter = Math.floor(Math.random() * 500);
        const delayMs = base + jitter;
        ctx.logger.warn(`[proofwork-worker] restarting in ${delayMs}ms (attempt=${restartAttempt})`);
        restartTimer = setTimeout(() => {
          restartTimer = null;
          try {
            if (lastCtx && cfg && cfg.enabled && cfg.autoStart) spawnWorker(lastCtx);
          } catch (err) {
            ctx.logger.error(`[proofwork-worker] restart failed: ${String(err)}`);
          }
        }, delayMs);
      });

      restartAttempt = 0;
    };

    api.registerService({
      id: "proofwork-worker",
      start: async (ctx) => {
        lastCtx = ctx;
        cfg = parseConfig(api.pluginConfig);
        if (!cfg.enabled) {
          ctx.logger.info("[proofwork-worker] disabled; not starting");
          return;
        }
        if (!cfg.autoStart) {
          ctx.logger.info("[proofwork-worker] autoStart=false; not starting");
          return;
        }

        const paths = getPaths(ctx);
        fs.mkdirSync(paths.root, { recursive: true });

        if (cfg.resetBrowserProfileOnStart) {
          try {
            ctx.logger.warn(`[proofwork-worker] resetting browser profile: ${cfg.browserProfile}`);
            const reset = spawn(cfg.openclawBin, ["browser", "--browser-profile", cfg.browserProfile, "reset-profile", "--json"], {
              env: process.env,
              stdio: ["ignore", "pipe", "pipe"],
            });
            await new Promise<void>((resolve) => reset.on("close", () => resolve()));
          } catch (err) {
            ctx.logger.warn(`[proofwork-worker] browser reset failed: ${String(err)}`);
          }
        }

        try {
          spawnWorker(ctx);
        } catch (err) {
          ctx.logger.error(`[proofwork-worker] start failed: ${String(err)}`);
        }
      },
      stop: async (ctx) => {
        await stopChild(ctx);
        const paths = getPaths(ctx);
        unlinkIfExists(paths.lockFile);
      },
    });

    api.registerCommand({
      name: "proofwork",
      description: "Manage the Proofwork worker (status|pause|resume|token rotate|browser reset)",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        const args = String(ctx.args ?? "").trim();
        const verb = args.split(/\s+/)[0]?.toLowerCase() || "status";
        const rest = args.split(/\s+/).slice(1);
        if (!lastCtx) {
          return { text: "proofwork-worker: not started (service not initialized yet)" };
        }
        const paths = getPaths(lastCtx);

        const statusRaw = readTextIfExists(paths.statusFile);
        const status = statusRaw ? safeJsonParse<Record<string, unknown>>(statusRaw) : null;
        const running = Boolean(child && child.pid && isPidAlive(child.pid));
        const paused = isPaused(paths.pauseFile);

        if (verb === "status") {
          const tokenMetaRaw = readTextIfExists(paths.tokenFile);
          const tokenMeta = tokenMetaRaw ? safeJsonParse<Record<string, unknown>>(tokenMetaRaw) : null;
          const workerId = typeof tokenMeta?.workerId === "string" ? tokenMeta.workerId : undefined;
          const lastError = typeof status?.lastError === "string" ? status.lastError : undefined;
          const lastJobId = typeof status?.lastJobId === "string" ? status.lastJobId : undefined;
          const lastPollAt = typeof status?.lastPollAt === "number" ? new Date(status.lastPollAt).toISOString() : undefined;
          return {
            text: [
              `proofwork-worker`,
              `- running: ${running}${child?.pid ? ` (pid=${child.pid})` : ""}`,
              `- paused: ${paused}`,
              `- apiBaseUrl: ${(cfg ? cfg.apiBaseUrl : "(unknown)")}`,
              `- browserProfile: ${(cfg ? cfg.browserProfile : "(unknown)")}`,
              workerId ? `- workerId: ${workerId}` : `- workerId: (unknown)`,
              lastPollAt ? `- lastPollAt: ${lastPollAt}` : undefined,
              lastJobId ? `- lastJobId: ${lastJobId}` : undefined,
              lastError ? `- lastError: ${lastError}` : undefined,
            ]
              .filter(Boolean)
              .join("\n"),
          };
        }

        if (verb === "pause") {
          writeFileAtomic(paths.pauseFile, "paused\n", 0o600);
          await stopChild(lastCtx);
          unlinkIfExists(paths.lockFile);
          return { text: "proofwork-worker paused" };
        }

        if (verb === "resume") {
          unlinkIfExists(paths.pauseFile);
          if (cfg && cfg.enabled && cfg.autoStart) {
            try {
              spawnWorker(lastCtx);
            } catch (err) {
              return { text: `resume failed: ${String(err)}` };
            }
          }
          return { text: "proofwork-worker resumed" };
        }

        if (verb === "token" && rest[0]?.toLowerCase() === "rotate") {
          unlinkIfExists(paths.tokenFile);
          await stopChild(lastCtx);
          unlinkIfExists(paths.lockFile);
          if (cfg && cfg.enabled && cfg.autoStart && !isPaused(paths.pauseFile)) {
            try {
              spawnWorker(lastCtx);
            } catch (err) {
              return { text: `token rotate restart failed: ${String(err)}` };
            }
          }
          return { text: "proofwork-worker token rotated (will re-register on next start)" };
        }

        if (verb === "browser" && rest[0]?.toLowerCase() === "reset") {
          if (!cfg) return { text: "missing config" };
          try {
            const p = spawn(cfg.openclawBin, ["browser", "--browser-profile", cfg.browserProfile, "reset-profile", "--json"], {
              env: process.env,
              stdio: ["ignore", "pipe", "pipe"],
            });
            await new Promise<void>((resolve) => p.on("close", () => resolve()));
            return { text: `browser profile reset: ${cfg.browserProfile}` };
          } catch (err) {
            return { text: `browser reset failed: ${String(err)}` };
          }
        }

        if (verb === "debug") {
          const on = (rest[0] ?? "").toLowerCase() === "on";
          writeFileAtomic(path.join(paths.root, "debug.flag"), on ? "1\n" : "0\n", 0o600);
          await stopChild(lastCtx);
          unlinkIfExists(paths.lockFile);
          if (cfg && cfg.enabled && cfg.autoStart && !isPaused(paths.pauseFile)) {
            try {
              spawnWorker(lastCtx);
            } catch (err) {
              return { text: `debug restart failed: ${String(err)}` };
            }
          }
          return { text: `debug ${on ? "on" : "off"}` };
        }

        return { text: "usage: /proofwork status|pause|resume|token rotate|browser reset|debug on|off" };
      },
    });
  },
};
