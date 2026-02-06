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

type ProofworkWorkerEntryConfig = {
  name: string;
  enabled: boolean;
  supportedCapabilityTags?: string[];
  minPayoutCents?: number;
  preferCapabilityTag?: string;
  requireTaskType?: string;
  canaryPercent?: number;
  pollIntervalMs?: number;
  originEnforcement?: "strict" | "off";
  noLogin?: boolean;
  valueEnvAllowlist?: string[];
  extraAllowedOrigins?: string[];
  jobTimeBudgetSec?: number;
  httpMaxBytes?: number;
  artifactMaxBytes?: number;
  ffmpegMaxDurationSec?: number;
  logLevel?: "info" | "debug";
  allowTaskTypes?: string[];
  denyTaskTypes?: string[];
  allowOrigins?: string[];
  denyOrigins?: string[];
  browserProfile?: string;
  openclawBin?: string;
  workerScriptPath?: string;
  payoutChain?: "base";
  payoutAddress?: string;
  payoutSignature?: string;
  dangerouslyEnableOpenclawAgentSummarize?: boolean;
  workerDisplayName?: string;
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
  payoutChain?: "base";
  payoutAddress?: string;
  payoutSignature?: string;
  dangerouslyEnableOpenclawAgentSummarize: boolean;
  workerDisplayName?: string;
  workers: ProofworkWorkerEntryConfig[];
};

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function fetchJson(input: {
  url: string;
  method?: string;
  token?: string;
  body?: unknown;
  timeoutMs?: number;
}): Promise<{ status: number; ok: boolean; json: unknown; text: string }> {
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(input.timeoutMs as any) ? Number(input.timeoutMs) : 15_000;
  const timer = setTimeout(() => controller.abort(), Math.max(250, timeoutMs));
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (input.token) headers.authorization = `Bearer ${input.token}`;
    let body: string | undefined;
    if (input.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(input.body);
    }
    const resp = await fetch(input.url, {
      method: input.method ?? (input.body === undefined ? "GET" : "POST"),
      headers,
      body,
      signal: controller.signal,
    });
    const text = await resp.text();
    let json: unknown = null;
    if (text.trim()) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text.slice(0, 10_000) };
      }
    }
    return { status: resp.status, ok: resp.ok, json, text };
  } finally {
    clearTimeout(timer);
  }
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
  const payoutChain = cfg.payoutChain === "base" ? "base" : undefined;
  const payoutAddress =
    typeof cfg.payoutAddress === "string" && cfg.payoutAddress.trim() ? cfg.payoutAddress.trim() : undefined;
  const payoutSignature =
    typeof cfg.payoutSignature === "string" && cfg.payoutSignature.trim() ? cfg.payoutSignature.trim() : undefined;
  const dangerouslyEnableOpenclawAgentSummarize =
    typeof cfg.dangerouslyEnableOpenclawAgentSummarize === "boolean"
      ? cfg.dangerouslyEnableOpenclawAgentSummarize
      : false;

  const workerDisplayName =
    typeof (cfg as any).workerDisplayName === "string" && String((cfg as any).workerDisplayName).trim()
      ? String((cfg as any).workerDisplayName).trim()
      : undefined;

  const workersRaw = Array.isArray((cfg as any).workers) ? ((cfg as any).workers as any[]) : [];
  const workers: ProofworkWorkerEntryConfig[] = [];
  const seenWorkers = new Set<string>();
  for (const w of workersRaw) {
    if (!w || typeof w !== "object") continue;
    const name = typeof (w as any).name === "string" ? String((w as any).name).trim() : "";
    if (!name) throw new Error("workers[].name is required");
    const key = name.toLowerCase();
    if (seenWorkers.has(key)) throw new Error(`duplicate worker name: ${name}`);
    seenWorkers.add(key);

    const enabledW = typeof (w as any).enabled === "boolean" ? Boolean((w as any).enabled) : true;
    const supportedCapabilityTagsW = Array.isArray((w as any).supportedCapabilityTags)
      ? (w as any).supportedCapabilityTags.map((t: any) => String(t).trim()).filter(Boolean)
      : undefined;
    if (Array.isArray((w as any).supportedCapabilityTags) && (supportedCapabilityTagsW?.length ?? 0) === 0) {
      throw new Error(`workers[${name}].supportedCapabilityTags must not be empty`);
    }

    const allowTaskTypesW = Array.isArray((w as any).allowTaskTypes)
      ? (w as any).allowTaskTypes.map((s: any) => String(s).trim()).filter(Boolean)
      : undefined;
    const denyTaskTypesW = Array.isArray((w as any).denyTaskTypes)
      ? (w as any).denyTaskTypes.map((s: any) => String(s).trim()).filter(Boolean)
      : undefined;
    const allowOriginsW = Array.isArray((w as any).allowOrigins)
      ? (w as any).allowOrigins.map((s: any) => String(s).trim()).filter(Boolean)
      : undefined;
    const denyOriginsW = Array.isArray((w as any).denyOrigins)
      ? (w as any).denyOrigins.map((s: any) => String(s).trim()).filter(Boolean)
      : undefined;

    const entry: ProofworkWorkerEntryConfig = {
      name,
      enabled: enabledW,
      supportedCapabilityTags: supportedCapabilityTagsW,
      minPayoutCents: (w as any).minPayoutCents === undefined ? undefined : Number((w as any).minPayoutCents),
      preferCapabilityTag:
        typeof (w as any).preferCapabilityTag === "string" && String((w as any).preferCapabilityTag).trim()
          ? String((w as any).preferCapabilityTag).trim()
          : undefined,
      requireTaskType:
        typeof (w as any).requireTaskType === "string" && String((w as any).requireTaskType).trim()
          ? String((w as any).requireTaskType).trim()
          : undefined,
      canaryPercent: (w as any).canaryPercent === undefined ? undefined : Number((w as any).canaryPercent),
      pollIntervalMs: (w as any).pollIntervalMs === undefined ? undefined : Number((w as any).pollIntervalMs),
      originEnforcement: (w as any).originEnforcement === "off" ? "off" : (w as any).originEnforcement === "strict" ? "strict" : undefined,
      noLogin: typeof (w as any).noLogin === "boolean" ? Boolean((w as any).noLogin) : undefined,
      valueEnvAllowlist: Array.isArray((w as any).valueEnvAllowlist)
        ? (w as any).valueEnvAllowlist.map((s: any) => String(s).trim()).filter(Boolean)
        : undefined,
      extraAllowedOrigins: Array.isArray((w as any).extraAllowedOrigins)
        ? (w as any).extraAllowedOrigins.map((s: any) => String(s).trim()).filter(Boolean)
        : undefined,
      jobTimeBudgetSec: (w as any).jobTimeBudgetSec === undefined ? undefined : Number((w as any).jobTimeBudgetSec),
      httpMaxBytes: (w as any).httpMaxBytes === undefined ? undefined : Number((w as any).httpMaxBytes),
      artifactMaxBytes: (w as any).artifactMaxBytes === undefined ? undefined : Number((w as any).artifactMaxBytes),
      ffmpegMaxDurationSec: (w as any).ffmpegMaxDurationSec === undefined ? undefined : Number((w as any).ffmpegMaxDurationSec),
      logLevel: (w as any).logLevel === "debug" ? "debug" : (w as any).logLevel === "info" ? "info" : undefined,
      allowTaskTypes: allowTaskTypesW,
      denyTaskTypes: denyTaskTypesW,
      allowOrigins: allowOriginsW,
      denyOrigins: denyOriginsW,
      browserProfile:
        typeof (w as any).browserProfile === "string" && String((w as any).browserProfile).trim()
          ? String((w as any).browserProfile).trim()
          : undefined,
      openclawBin:
        typeof (w as any).openclawBin === "string" && String((w as any).openclawBin).trim()
          ? String((w as any).openclawBin).trim()
          : undefined,
      workerScriptPath:
        typeof (w as any).workerScriptPath === "string" && String((w as any).workerScriptPath).trim()
          ? String((w as any).workerScriptPath).trim()
          : undefined,
      payoutChain: (w as any).payoutChain === "base" ? "base" : undefined,
      payoutAddress:
        typeof (w as any).payoutAddress === "string" && String((w as any).payoutAddress).trim()
          ? String((w as any).payoutAddress).trim()
          : undefined,
      payoutSignature:
        typeof (w as any).payoutSignature === "string" && String((w as any).payoutSignature).trim()
          ? String((w as any).payoutSignature).trim()
          : undefined,
      dangerouslyEnableOpenclawAgentSummarize:
        typeof (w as any).dangerouslyEnableOpenclawAgentSummarize === "boolean"
          ? Boolean((w as any).dangerouslyEnableOpenclawAgentSummarize)
          : undefined,
      workerDisplayName:
        typeof (w as any).workerDisplayName === "string" && String((w as any).workerDisplayName).trim()
          ? String((w as any).workerDisplayName).trim()
          : undefined,
    };
    workers.push(entry);
  }

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
    payoutChain,
    payoutAddress,
    payoutSignature,
    dangerouslyEnableOpenclawAgentSummarize,
    workerDisplayName,
    workers,
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
    if (/token|secret|password|key|signature|private/i.test(k)) out[k] = "<redacted>";
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

function formatUsdCents(cents: unknown): string {
  const n = Number(cents);
  if (!Number.isFinite(n)) return "(unknown)";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(Math.floor(n));
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

function getWorkerTokenFromTokenFile(tokenFile: string): { token: string; workerId?: string } | null {
  const raw = readTextIfExists(tokenFile);
  if (!raw) return null;
  const j = safeJsonParse<{ token?: unknown; workerId?: unknown }>(raw);
  const token = typeof j?.token === "string" ? j.token.trim() : "";
  const workerId = typeof j?.workerId === "string" ? j.workerId.trim() : undefined;
  if (!token) return null;
  return { token, workerId };
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

  if (params.cfg.payoutChain) base.PROOFWORK_PAYOUT_CHAIN = params.cfg.payoutChain;
  if (params.cfg.payoutAddress) base.PROOFWORK_PAYOUT_ADDRESS = params.cfg.payoutAddress;
  if (params.cfg.payoutSignature) base.PROOFWORK_PAYOUT_SIGNATURE = params.cfg.payoutSignature;

  if (params.cfg.workerDisplayName) base.PROOFWORK_WORKER_DISPLAY_NAME = params.cfg.workerDisplayName;

  base.PROOFWORK_DANGEROUS_ENABLE_OPENCLAW_AGENT_SUMMARIZE = params.cfg.dangerouslyEnableOpenclawAgentSummarize
    ? "true"
    : "false";

  return base;
}

function resolveWorkerScriptPath(): string {
  const here = fileURLToPath(import.meta.url);
  const dir = path.dirname(here);

  // Prefer a bundled worker script (npm-distributed plugin package).
  const bundled = path.resolve(dir, "assets", "proofwork_worker.mjs");
  if (exists(bundled)) return bundled;

  // Dev fallback: monorepo layout.
  // Plugin root: integrations/openclaw/plugins/proofwork-worker
  // Worker script: integrations/openclaw/skills/proofwork-universal-worker/scripts/proofwork_worker.mjs
  return path.resolve(dir, "../../skills/proofwork-universal-worker/scripts/proofwork_worker.mjs");
}

export const __internal = {
  parseConfig,
  computeStateRoot,
  buildWorkerEnv,
  resolveWorkerScriptPath,
  isPidAlive,
  redactEnvForLogs,
  parseArgsCsv,
  fetchJson,
  getWorkerTokenFromTokenFile,
};

export default {
  id: "proofwork-worker",
  name: "Proofwork Worker",
  description: "Runs a Proofwork universal worker loop in the background.",
  register(api: PluginApi) {
    type WorkerSpec = {
      name: string;
      key: string;
      tokenFile: string;
      statusFile: string;
      cfg: ProofworkPluginConfig;
      scriptPath: string;
    };
    type WorkerRuntime = {
      spec: WorkerSpec;
      child: ChildProcessWithoutNullStreams | null;
      restartTimer: NodeJS.Timeout | null;
      restartAttempt: number;
    };

    let lastCtx: PluginServiceContext | null = null;
    let cfg: ProofworkPluginConfig | null = null;
    let stoppingAll = false;
    let serviceLockHeld = false;

    const runtimes = new Map<string, WorkerRuntime>();

    const getPaths = (ctx: PluginServiceContext) => {
      const { root, workspaceHash } = computeStateRoot({ stateDir: ctx.stateDir, workspaceDir: ctx.workspaceDir });
      const pauseFile = path.join(root, "pause.flag");
      const lockFile = path.join(root, "lock.json");
      const debugFile = path.join(root, "debug.flag");
      return { root, workspaceHash, pauseFile, lockFile, debugFile };
    };

    const isPaused = (pauseFile: string) => exists(pauseFile);

    const isDebugOn = (debugFile: string) => {
      const raw = readTextIfExists(debugFile);
      const v = String(raw ?? "")
        .trim()
        .toLowerCase();
      return v === "1" || v === "true" || v === "yes" || v === "on";
    };

    const sanitizeWorkerKey = (name: string) => {
      const base = String(name ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "_")
        .replace(/^_+|_+$/g, "");
      const h = sha256Hex(String(name ?? "")).slice(0, 6);
      const out = base ? `${base}-${h}` : h;
      return out.slice(0, 40) || h;
    };

    const clampInt = (n: unknown, bounds: { min: number; max: number }): number | undefined => {
      if (n === undefined) return undefined;
      const v = Number(n);
      if (!Number.isFinite(v)) return undefined;
      return Math.max(bounds.min, Math.min(bounds.max, Math.floor(v)));
    };

    const mergeWorkerConfig = (base: ProofworkPluginConfig, entry: ProofworkWorkerEntryConfig | null): ProofworkPluginConfig => {
      const out: ProofworkPluginConfig = { ...base };
      if (!entry) return out;

      if (entry.supportedCapabilityTags) out.supportedCapabilityTags = entry.supportedCapabilityTags;
      if (entry.minPayoutCents !== undefined && Number.isFinite(entry.minPayoutCents as any)) out.minPayoutCents = Number(entry.minPayoutCents);
      if (entry.preferCapabilityTag !== undefined) out.preferCapabilityTag = entry.preferCapabilityTag;
      if (entry.requireTaskType !== undefined) out.requireTaskType = entry.requireTaskType;
      if (entry.canaryPercent !== undefined) out.canaryPercent = clampInt(entry.canaryPercent, { min: 0, max: 100 }) ?? out.canaryPercent;
      if (entry.pollIntervalMs !== undefined) out.pollIntervalMs = clampInt(entry.pollIntervalMs, { min: 250, max: 60_000 }) ?? out.pollIntervalMs;
      if (entry.originEnforcement) out.originEnforcement = entry.originEnforcement;
      if (entry.noLogin !== undefined) out.noLogin = entry.noLogin;
      if (entry.valueEnvAllowlist !== undefined) out.valueEnvAllowlist = entry.valueEnvAllowlist;
      if (entry.extraAllowedOrigins !== undefined) out.extraAllowedOrigins = entry.extraAllowedOrigins;
      if (entry.jobTimeBudgetSec !== undefined) out.jobTimeBudgetSec = clampInt(entry.jobTimeBudgetSec, { min: 10, max: 3600 });
      if (entry.httpMaxBytes !== undefined) out.httpMaxBytes = clampInt(entry.httpMaxBytes, { min: 1024, max: 50_000_000 }) ?? out.httpMaxBytes;
      if (entry.artifactMaxBytes !== undefined) out.artifactMaxBytes = clampInt(entry.artifactMaxBytes, { min: 1024, max: 500_000_000 });
      if (entry.ffmpegMaxDurationSec !== undefined)
        out.ffmpegMaxDurationSec = clampInt(entry.ffmpegMaxDurationSec, { min: 1, max: 600 }) ?? out.ffmpegMaxDurationSec;
      if (entry.logLevel) out.logLevel = entry.logLevel;
      if (entry.allowTaskTypes !== undefined) out.allowTaskTypes = entry.allowTaskTypes;
      if (entry.denyTaskTypes !== undefined) out.denyTaskTypes = entry.denyTaskTypes;
      if (entry.allowOrigins !== undefined) out.allowOrigins = entry.allowOrigins;
      if (entry.denyOrigins !== undefined) out.denyOrigins = entry.denyOrigins;
      if (entry.browserProfile) out.browserProfile = entry.browserProfile;
      if (entry.openclawBin) out.openclawBin = entry.openclawBin;
      if (entry.workerScriptPath !== undefined) out.workerScriptPath = entry.workerScriptPath;
      if (entry.payoutChain !== undefined) out.payoutChain = entry.payoutChain;
      if (entry.payoutAddress !== undefined) out.payoutAddress = entry.payoutAddress;
      if (entry.payoutSignature !== undefined) out.payoutSignature = entry.payoutSignature;
      if (entry.dangerouslyEnableOpenclawAgentSummarize !== undefined) {
        out.dangerouslyEnableOpenclawAgentSummarize = entry.dangerouslyEnableOpenclawAgentSummarize;
      }
      if (entry.workerDisplayName !== undefined) out.workerDisplayName = entry.workerDisplayName;
      return out;
    };

    const computeWorkerSpecs = (ctx: PluginServiceContext, baseCfg: ProofworkPluginConfig): WorkerSpec[] => {
      const paths = getPaths(ctx);
      const multi = Array.isArray(baseCfg.workers) && baseCfg.workers.length > 0;
      const entries: ProofworkWorkerEntryConfig[] = multi ? baseCfg.workers : [{ name: "default", enabled: true }];

      const out: WorkerSpec[] = [];
      for (const entry of entries) {
        if (!entry.enabled) continue;
        const effective = mergeWorkerConfig(baseCfg, multi ? entry : null);
        if (multi) {
          const baseName = entry.workerDisplayName ?? baseCfg.workerDisplayName;
          effective.workerDisplayName = baseName
            ? entry.workerDisplayName
              ? entry.workerDisplayName
              : `${baseName} (${entry.name})`
            : entry.name;
        }
        const key = multi ? sanitizeWorkerKey(entry.name) : "default";
        const tokenFile = multi ? path.join(paths.root, `worker-token.${key}.json`) : path.join(paths.root, "worker-token.json");
        const statusFile = multi ? path.join(paths.root, `status.${key}.json`) : path.join(paths.root, "status.json");
        const scriptPath = effective.workerScriptPath ? path.resolve(effective.workerScriptPath) : resolveWorkerScriptPath();
        out.push({ name: entry.name, key, tokenFile, statusFile, cfg: effective, scriptPath });
      }
      return out;
    };

    const acquireServiceLock = (ctx: PluginServiceContext, lockFile: string) => {
      if (serviceLockHeld) return;
      const raw = readTextIfExists(lockFile);
      if (raw) {
        const j = safeJsonParse<{ pid?: number; startedAt?: number }>(raw);
        const pid = Number(j?.pid ?? 0);
        if (isPidAlive(pid) && pid !== process.pid) {
          throw new Error(`already_running(pid=${pid})`);
        }
      }
      const lock = { pid: process.pid, startedAt: Date.now(), hostname: os.hostname() };
      writeFileAtomic(lockFile, JSON.stringify(lock, null, 2) + "\n", 0o600);
      serviceLockHeld = true;
      ctx.logger.debug(`[proofwork-worker] service lock acquired pid=${process.pid}`);
    };

    const releaseServiceLock = (lockFile: string) => {
      serviceLockHeld = false;
      unlinkIfExists(lockFile);
    };

    const waitForPidExit = async (pid: number, timeoutMs: number) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (!isPidAlive(pid)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
    };

    const killWorkerProcess = async (ctx: PluginServiceContext, proc: ChildProcessWithoutNullStreams, name: string) => {
      const pid = proc.pid;
      if (!pid) return;
      ctx.logger.info(`[proofwork-worker:${name}] stopping child pid=${pid}`);

      try {
        if (process.platform !== "win32") {
          // Best-effort kill the process group when detached.
          try {
            process.kill(-pid, "SIGTERM");
          } catch {
            proc.kill("SIGTERM");
          }
        } else {
          proc.kill("SIGTERM");
        }
      } catch {
        // ignore
      }
      await waitForPidExit(pid, 3000);

      if (!isPidAlive(pid)) return;
      try {
        if (process.platform !== "win32") {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            proc.kill("SIGKILL");
          }
        } else {
          proc.kill("SIGKILL");
        }
      } catch {
        // ignore
      }
      await waitForPidExit(pid, 2000);
    };

    const stopAllWorkers = async (ctx: PluginServiceContext) => {
      stoppingAll = true;
      for (const rt of runtimes.values()) {
        if (rt.restartTimer) {
          clearTimeout(rt.restartTimer);
          rt.restartTimer = null;
        }
      }
      const kills: Promise<void>[] = [];
      for (const [name, rt] of runtimes.entries()) {
        if (!rt.child) continue;
        const proc = rt.child;
        rt.child = null;
        kills.push(killWorkerProcess(ctx, proc, name));
      }
      await Promise.allSettled(kills);
      stoppingAll = false;
    };

    const isWorkerEnabledByConfig = (name: string) => {
      if (!lastCtx || !cfg) return false;
      const specs = computeWorkerSpecs(lastCtx, cfg);
      return specs.some((s) => s.name.toLowerCase() === name.toLowerCase());
    };

    const spawnWorker = (ctx: PluginServiceContext, spec: WorkerSpec) => {
      if (!cfg) throw new Error("missing_config");
      const paths = getPaths(ctx);
      fs.mkdirSync(paths.root, { recursive: true });

      if (isPaused(paths.pauseFile)) {
        ctx.logger.info("[proofwork-worker] paused; not starting");
        return;
      }
      if (!cfg.apiBaseUrl) {
        ctx.logger.warn(
          "[proofwork-worker] apiBaseUrl is not set; configure plugins.entries.proofwork-worker.config.apiBaseUrl",
        );
        return;
      }

      const rt = runtimes.get(spec.name);
      if (rt?.child?.pid && isPidAlive(rt.child.pid)) return;

      if (!exists(spec.scriptPath)) {
        throw new Error(`worker_script_not_found:${spec.scriptPath}`);
      }

      const env = buildWorkerEnv({
        baseEnv: process.env,
        cfg: spec.cfg,
        tokenFile: spec.tokenFile,
        pauseFile: paths.pauseFile,
        statusFile: spec.statusFile,
        stateDir: ctx.stateDir,
      });
      if (isDebugOn(paths.debugFile)) env.PROOFWORK_LOG_LEVEL = "debug";

      ctx.logger.info(
        `[proofwork-worker:${spec.name}] spawning node=${process.execPath} script=${spec.scriptPath} env=${JSON.stringify(
          redactEnvForLogs(env),
        )}`,
      );

      const proc = spawn(process.execPath, [spec.scriptPath], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      const runtime: WorkerRuntime = rt ?? { spec, child: null, restartTimer: null, restartAttempt: 0 };
      runtime.spec = spec;
      runtime.child = proc;
      runtimes.set(spec.name, runtime);

      const onLine = (line: string, kind: "stdout" | "stderr") => {
        const s = line.trimEnd();
        if (!s) return;
        if (kind === "stderr") ctx.logger.warn(`[proofwork-worker:${spec.name}] ${s}`);
        else ctx.logger.info(`[proofwork-worker:${spec.name}] ${s}`);
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
        const runtimeNow = runtimes.get(spec.name);
        if (runtimeNow) runtimeNow.child = null;

        if (stoppingAll) return;
        if (isPaused(getPaths(ctx).pauseFile)) {
          ctx.logger.info(`[proofwork-worker:${spec.name}] paused after exit; not restarting`);
          return;
        }
        if (!isWorkerEnabledByConfig(spec.name)) {
          ctx.logger.info(`[proofwork-worker:${spec.name}] disabled; not restarting`);
          return;
        }

        ctx.logger.warn(`[proofwork-worker:${spec.name}] child exited code=${code} signal=${signal ?? ""}`);

        const rt2 = runtimes.get(spec.name);
        if (!rt2) return;
        rt2.restartAttempt += 1;
        const base = Math.min(60_000, 1000 * Math.pow(2, Math.min(6, rt2.restartAttempt)));
        const jitter = Math.floor(Math.random() * 500);
        const delayMs = base + jitter;
        ctx.logger.warn(`[proofwork-worker:${spec.name}] restarting in ${delayMs}ms (attempt=${rt2.restartAttempt})`);
        rt2.restartTimer = setTimeout(() => {
          rt2.restartTimer = null;
          try {
            if (lastCtx && cfg && cfg.enabled && cfg.autoStart && cfg.apiBaseUrl) {
              // Recompute spec in case config changed.
              const specs = computeWorkerSpecs(lastCtx, cfg);
              const nextSpec = specs.find((s) => s.name.toLowerCase() === spec.name.toLowerCase());
              if (nextSpec) spawnWorker(lastCtx, nextSpec);
            }
          } catch (err) {
            ctx.logger.error(`[proofwork-worker:${spec.name}] restart failed: ${String(err)}`);
          }
        }, delayMs);
      });

      runtime.restartAttempt = 0;
    };

    const ensureWorkersRunning = (ctx: PluginServiceContext) => {
      if (!cfg) throw new Error("missing_config");
      const paths = getPaths(ctx);
      fs.mkdirSync(paths.root, { recursive: true });
      if (isPaused(paths.pauseFile)) return;

      acquireServiceLock(ctx, paths.lockFile);

      const desired = computeWorkerSpecs(ctx, cfg);
      const desiredNames = new Set(desired.map((s) => s.name.toLowerCase()));

      // Stop workers no longer enabled.
      for (const [name, rt] of runtimes.entries()) {
        if (desiredNames.has(name.toLowerCase())) continue;
        if (rt.restartTimer) {
          clearTimeout(rt.restartTimer);
          rt.restartTimer = null;
        }
        if (rt.child) {
          void killWorkerProcess(ctx, rt.child, name);
        }
        runtimes.delete(name);
      }

      for (const spec of desired) {
        try {
          spawnWorker(ctx, spec);
        } catch (err) {
          ctx.logger.error(`[proofwork-worker:${spec.name}] spawn failed: ${String(err)}`);
        }
      }
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
        if (!cfg.apiBaseUrl) {
          ctx.logger.warn("[proofwork-worker] apiBaseUrl is not set; configure plugins.entries.proofwork-worker.config.apiBaseUrl");
          return;
        }
        if (!cfg.autoStart) {
          ctx.logger.info("[proofwork-worker] autoStart=false; not starting");
          return;
        }

        const paths = getPaths(ctx);
        fs.mkdirSync(paths.root, { recursive: true });

        if (isPaused(paths.pauseFile)) {
          ctx.logger.info("[proofwork-worker] paused; not starting");
          return;
        }

        if (cfg.resetBrowserProfileOnStart) {
          try {
            const specs = computeWorkerSpecs(ctx, cfg);
            const profiles = Array.from(new Set(specs.map((s) => s.cfg.browserProfile).filter(Boolean)));
            for (const profile of profiles) {
              ctx.logger.warn(`[proofwork-worker] resetting browser profile: ${profile}`);
              const reset = spawn(cfg.openclawBin, ["browser", "--browser-profile", profile, "reset-profile", "--json"], {
                env: process.env,
                stdio: ["ignore", "pipe", "pipe"],
              });
              await new Promise<void>((resolve) => reset.on("close", () => resolve()));
            }
          } catch (err) {
            ctx.logger.warn(`[proofwork-worker] browser reset failed: ${String(err)}`);
          }
        }

        try {
          ensureWorkersRunning(ctx);
        } catch (err) {
          ctx.logger.error(`[proofwork-worker] start failed: ${String(err)}`);
        }
      },
      stop: async (ctx) => {
        await stopAllWorkers(ctx);
        const paths = getPaths(ctx);
        releaseServiceLock(paths.lockFile);
      },
    });

    api.registerCommand({
      name: "proofwork",
      description: "Manage the Proofwork worker (status|pause|resume|token rotate|browser reset|payout)",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        const rawArgs = String(ctx.args ?? "").trim();
        const tokensRaw = rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : [];

        // Strip optional --worker flag from args (used for payout/payouts/earnings in multi-worker mode).
        let workerHint: string | undefined;
        const tokens: string[] = [];
        for (let i = 0; i < tokensRaw.length; i++) {
          const t = tokensRaw[i];
          if (t === "--worker" || t === "-w") {
            workerHint = tokensRaw[i + 1] ? String(tokensRaw[i + 1]) : undefined;
            i += 1;
            continue;
          }
          if (t.startsWith("--worker=")) {
            workerHint = String(t.split("=", 2)[1] ?? "").trim() || undefined;
            continue;
          }
          tokens.push(t);
        }

        const verb = tokens[0]?.toLowerCase() || "status";
        const rest = tokens.slice(1);
        if (!lastCtx) return { text: "proofwork-worker: not started (service not initialized yet)" };
        const paths = getPaths(lastCtx);

        const paused = isPaused(paths.pauseFile);

        const specs = cfg ? computeWorkerSpecs(lastCtx, cfg) : [];
        const findSpec = (name?: string): WorkerSpec | null => {
          if (!specs.length) return null;
          if (name) {
            const needle = String(name).trim().toLowerCase();
            const found = specs.find((s) => s.name.toLowerCase() === needle);
            return found ?? null;
          }
          if (specs.length === 1) return specs[0] ?? null;
          return specs[0] ?? null;
        };
        const selectedSpec = findSpec(workerHint);
        const selectedStatusRaw = selectedSpec ? readTextIfExists(selectedSpec.statusFile) : null;
        const selectedStatus = selectedStatusRaw ? safeJsonParse<Record<string, unknown>>(selectedStatusRaw) : null;
        const selectedRt = selectedSpec ? runtimes.get(selectedSpec.name) : null;
        const selectedRunning = Boolean(selectedRt?.child?.pid && isPidAlive(selectedRt.child.pid));

        if (verb === "status") {
          const lines: string[] = [];
          lines.push("proofwork-worker");
          lines.push(`- paused: ${paused}`);
          lines.push(`- apiBaseUrl: ${cfg ? cfg.apiBaseUrl || "(not set)" : "(unknown)"}`);
          if (specs.length > 1) lines.push(`- workers: ${specs.length}`);

          const renderOne = (spec: WorkerSpec) => {
            const rt = runtimes.get(spec.name);
            const running = Boolean(rt?.child?.pid && isPidAlive(rt.child.pid));
            const statusRaw = readTextIfExists(spec.statusFile);
            const status = statusRaw ? safeJsonParse<Record<string, unknown>>(statusRaw) : null;
            const tokenMeta = getWorkerTokenFromTokenFile(spec.tokenFile);
            const workerId = tokenMeta?.workerId ?? (typeof status?.workerId === "string" ? String(status.workerId) : undefined);
            const lastError = typeof status?.lastError === "string" ? status.lastError : undefined;
            const lastJobId = typeof status?.lastJobId === "string" ? status.lastJobId : undefined;
            const lastPollAt = typeof status?.lastPollAt === "number" ? new Date(status.lastPollAt).toISOString() : undefined;
            const browserReady = typeof status?.browserReady === "boolean" ? status.browserReady : undefined;
            const lastBrowserHealthAt =
              typeof status?.lastBrowserHealthAt === "number" ? new Date(status.lastBrowserHealthAt).toISOString() : undefined;
            const lastBrowserError = typeof status?.lastBrowserError === "string" ? status.lastBrowserError : undefined;
            const ffmpegReady = typeof status?.ffmpegReady === "boolean" ? (status as any).ffmpegReady : undefined;
            const lastFfmpegHealthAt =
              typeof status?.lastFfmpegHealthAt === "number" ? new Date((status as any).lastFfmpegHealthAt).toISOString() : undefined;
            const lastFfmpegError = typeof status?.lastFfmpegError === "string" ? (status as any).lastFfmpegError : undefined;
            const effectiveCapabilityTags = Array.isArray(status?.effectiveCapabilityTags)
              ? (status?.effectiveCapabilityTags as any[]).map((t: any) => String(t)).filter(Boolean)
              : undefined;

            lines.push("");
            lines.push(`worker ${spec.name}`);
            lines.push(`- running: ${running}${rt?.child?.pid ? ` (pid=${rt.child.pid})` : ""}`);
            lines.push(`- browserProfile: ${spec.cfg.browserProfile}`);
            lines.push(workerId ? `- workerId: ${workerId}` : `- workerId: (unknown)`);
            if (effectiveCapabilityTags) lines.push(`- effectiveCapabilityTags: ${effectiveCapabilityTags.join(",")}`);
            if (browserReady !== undefined) lines.push(`- browserReady: ${browserReady}`);
            if (lastBrowserHealthAt) lines.push(`- lastBrowserHealthAt: ${lastBrowserHealthAt}`);
            if (lastBrowserError) lines.push(`- lastBrowserError: ${lastBrowserError}`);
            if (ffmpegReady !== undefined) lines.push(`- ffmpegReady: ${ffmpegReady}`);
            if (lastFfmpegHealthAt) lines.push(`- lastFfmpegHealthAt: ${lastFfmpegHealthAt}`);
            if (lastFfmpegError) lines.push(`- lastFfmpegError: ${lastFfmpegError}`);
            if (lastPollAt) lines.push(`- lastPollAt: ${lastPollAt}`);
            if (lastJobId) lines.push(`- lastJobId: ${lastJobId}`);
            if (lastError) lines.push(`- lastError: ${lastError}`);
          };

          if (specs.length <= 1) {
            const spec = selectedSpec ?? specs[0];
            if (spec) renderOne(spec);
          } else {
            for (const spec of specs) renderOne(spec);
            lines.push("");
            lines.push("Tip: target a specific worker with `--worker <name>` (for payout/payouts/earnings).");
          }

          return { text: lines.join("\n") };
        }

        if (verb === "payout") {
          const sub = (rest[0] ?? "status").toLowerCase();
          const subArgs = rest.slice(1);
          const activeCfg = (() => {
            if (cfg) return cfg;
            try {
              return parseConfig(api.pluginConfig);
            } catch {
              return null;
            }
          })();
          if (!activeCfg || !activeCfg.apiBaseUrl) {
            return { text: "missing config: set plugins.entries.proofwork-worker.config.apiBaseUrl first" };
          }

          const spec = selectedSpec;
          if (!spec) return { text: "no workers configured" };

          const tokenMeta = getWorkerTokenFromTokenFile(spec.tokenFile);
          if (!tokenMeta?.token) {
            return {
              text:
                "worker token not found yet. Wait for the worker to start + register, or run `/proofwork resume` if paused.",
            };
          }

          const apiBaseUrl = activeCfg.apiBaseUrl.replace(/\/$/, "");
          const withBase = (p: string) => `${apiBaseUrl}${p.startsWith("/") ? p : `/${p}`}`;

          if (sub === "status") {
            const me = await fetchJson({ url: withBase("/api/worker/me"), token: tokenMeta.token, timeoutMs: 10_000 });
            if (!me.ok) {
              return {
                text: `payout status failed: http ${me.status} ${typeof (me.json as any)?.error?.message === "string" ? (me.json as any).error.message : ""}`.trim(),
              };
            }
            const workerId = String((me.json as any)?.workerId ?? tokenMeta.workerId ?? "");
            const chain = String((me.json as any)?.payout?.chain ?? "");
            const address = String((me.json as any)?.payout?.address ?? "");
            const verifiedAt = (me.json as any)?.payout?.verifiedAt ?? null;
            return {
              text: [
                "proofwork payout",
                workerId ? `- workerId: ${workerId}` : undefined,
                chain ? `- chain: ${chain}` : `- chain: (not set)`,
                address ? `- address: ${address}` : `- address: (not set)`,
                verifiedAt ? `- verifiedAt: ${String(verifiedAt)}` : `- verifiedAt: (not verified)`,
              ]
                .filter(Boolean)
                .join("\n"),
            };
          }

          if (sub === "message") {
            const address = String(subArgs[0] ?? "").trim();
            const chain = String(subArgs[1] ?? "base").trim() || "base";
            if (!address) return { text: "usage: /proofwork payout message <0xAddress> [base]" };
            const msg = await fetchJson({
              url: withBase("/api/worker/payout-address/message"),
              token: tokenMeta.token,
              method: "POST",
              body: { chain, address },
              timeoutMs: 10_000,
            });
            if (!msg.ok) {
              return {
                text: `payout message failed: http ${msg.status} ${typeof (msg.json as any)?.error?.message === "string" ? (msg.json as any).error.message : ""}`.trim(),
              };
            }
            const message = String((msg.json as any)?.message ?? "").trim();
            if (!message) return { text: "payout message failed: missing message" };
            return {
              text: [
                "Sign this message with your wallet:",
                message,
                "",
                `Then run: /proofwork payout set ${address} <0xSignature> ${chain}`,
              ].join("\n"),
            };
          }

          if (sub === "set") {
            const address = String(subArgs[0] ?? "").trim();
            const signature = String(subArgs[1] ?? "").trim();
            const chain = String(subArgs[2] ?? "base").trim() || "base";
            if (!address || !signature) return { text: "usage: /proofwork payout set <0xAddress> <0xSignature> [base]" };
            const set = await fetchJson({
              url: withBase("/api/worker/payout-address"),
              token: tokenMeta.token,
              method: "POST",
              body: { chain, address, signature },
              timeoutMs: 15_000,
            });
            if (!set.ok) {
              return {
                text: `payout set failed: http ${set.status} ${typeof (set.json as any)?.error?.message === "string" ? (set.json as any).error.message : ""}`.trim(),
              };
            }
            const normalized = String((set.json as any)?.address ?? address);
            const unblocked = Number((set.json as any)?.unblockedPayouts ?? 0);
            return { text: `payout address verified: ${normalized} (unblockedPayouts=${unblocked})` };
          }

          return { text: "usage: /proofwork payout status|message <address> [chain]|set <address> <signature> [chain]" };
        }

        if (verb === "payouts" || verb === "earnings") {
          const activeCfg = (() => {
            if (cfg) return cfg;
            try {
              return parseConfig(api.pluginConfig);
            } catch {
              return null;
            }
          })();
          if (!activeCfg || !activeCfg.apiBaseUrl) {
            return { text: "missing config: set plugins.entries.proofwork-worker.config.apiBaseUrl first" };
          }

          const spec = selectedSpec;
          if (!spec) return { text: "no workers configured" };

          const tokenMeta = getWorkerTokenFromTokenFile(spec.tokenFile);
          if (!tokenMeta?.token) {
            return {
              text:
                "worker token not found yet. Wait for the worker to start + register, or run `/proofwork resume` if paused.",
            };
          }

          const apiBaseUrl = activeCfg.apiBaseUrl.replace(/\/$/, "");
          const withBase = (p: string) => `${apiBaseUrl}${p.startsWith("/") ? p : `/${p}`}`;

          const fetchPayouts = async (params: { status?: string; page: number; limit: number }) => {
            const qs = new URLSearchParams();
            qs.set("page", String(params.page));
            qs.set("limit", String(params.limit));
            if (params.status) qs.set("status", params.status);
            return await fetchJson({
              url: withBase(`/api/worker/payouts?${qs.toString()}`),
              token: tokenMeta.token,
              timeoutMs: 15_000,
            });
          };

          if (verb === "payouts") {
            const statusArg = String(rest[0] ?? "").trim().toLowerCase();
            const statusFilter = ["pending", "paid", "failed", "refunded"].includes(statusArg) ? statusArg : undefined;
            const pageArg = statusFilter ? rest[1] : rest[0];
            const limitArg = statusFilter ? rest[2] : rest[1];
            const page = Number.isFinite(Number(pageArg)) ? Math.max(1, Math.floor(Number(pageArg))) : 1;
            const limit = Number.isFinite(Number(limitArg)) ? Math.max(1, Math.min(50, Math.floor(Number(limitArg)))) : 10;

            const res = await fetchPayouts({ status: statusFilter, page, limit });
            if (!res.ok) {
              return {
                text: `payouts failed: http ${res.status} ${typeof (res.json as any)?.error?.message === "string" ? (res.json as any).error.message : ""}`.trim(),
              };
            }
            const payouts = Array.isArray((res.json as any)?.payouts) ? ((res.json as any).payouts as any[]) : [];
            const total = Number((res.json as any)?.total ?? payouts.length);

            const lines: string[] = [];
            lines.push("proofwork payouts");
            if (statusFilter) lines.push(`- status: ${statusFilter}`);
            lines.push(`- page: ${page} limit: ${limit} total: ${Number.isFinite(total) ? total : "(unknown)"}`);
            for (const p of payouts.slice(0, limit)) {
              const id = String(p?.id ?? "");
              const st = String(p?.status ?? "");
              const net = p?.netAmountCents !== null && p?.netAmountCents !== undefined ? formatUsdCents(p.netAmountCents) : "(pending)";
              const gross = formatUsdCents(p?.amountCents);
              const blocked = p?.blockedReason ? ` blocked=${String(p.blockedReason)}` : "";
              const title = p?.bountyTitle ? ` ${String(p.bountyTitle).slice(0, 60)}` : "";
              lines.push(`- ${id} ${st} net=${net} gross=${gross}${blocked}${title}`);
            }
            lines.push("");
            lines.push("Tip: filter by status with `/proofwork payouts pending|paid|failed|refunded`.");
            return { text: lines.join("\n") };
          }

          // earnings
          const limit = 200;
          const res = await fetchPayouts({ page: 1, limit });
          if (!res.ok) {
            return {
              text: `earnings failed: http ${res.status} ${typeof (res.json as any)?.error?.message === "string" ? (res.json as any).error.message : ""}`.trim(),
            };
          }
          const payouts = Array.isArray((res.json as any)?.payouts) ? ((res.json as any).payouts as any[]) : [];
          const total = Number((res.json as any)?.total ?? payouts.length);

          const counts: Record<string, number> = { paid: 0, pending: 0, failed: 0, refunded: 0 };
          let grossPaidCents = 0;
          let netPaidCents = 0;
          let blockedCount = 0;

          for (const p of payouts) {
            const st = String(p?.status ?? "");
            if (st in counts) counts[st] += 1;
            if (p?.blockedReason) blockedCount += 1;
            if (st === "paid") {
              grossPaidCents += Number(p?.amountCents ?? 0) || 0;
              netPaidCents += Number(p?.netAmountCents ?? p?.amountCents ?? 0) || 0;
            }
          }

          const lines: string[] = [];
          lines.push("proofwork earnings (from payouts)");
          lines.push(`- paid: ${formatUsdCents(netPaidCents)} net (${formatUsdCents(grossPaidCents)} gross)`);
          lines.push(`- counts (page 1): paid=${counts.paid} pending=${counts.pending} failed=${counts.failed} refunded=${counts.refunded} blocked=${blockedCount}`);
          if (Number.isFinite(total) && total > limit) {
            lines.push(`- note: showing first ${limit} payouts (total=${total}); use \`/proofwork payouts <status> <page>\` to browse.`);
          }
          return { text: lines.join("\n") };
        }

        if (verb === "pause") {
          writeFileAtomic(paths.pauseFile, "paused\n", 0o600);
          await stopAllWorkers(lastCtx);
          releaseServiceLock(paths.lockFile);
          return { text: "proofwork-worker paused" };
        }

        if (verb === "resume") {
          unlinkIfExists(paths.pauseFile);
          if (cfg && cfg.enabled && cfg.autoStart) {
            if (!cfg.apiBaseUrl) return { text: "missing config: set plugins.entries.proofwork-worker.config.apiBaseUrl first" };
            try {
              ensureWorkersRunning(lastCtx);
            } catch (err) {
              return { text: `resume failed: ${String(err)}` };
            }
          }
          return { text: "proofwork-worker resumed" };
        }

        if (verb === "token" && rest[0]?.toLowerCase() === "rotate") {
          const toRotate = cfg ? computeWorkerSpecs(lastCtx, cfg) : [];
          for (const s of toRotate) unlinkIfExists(s.tokenFile);
          await stopAllWorkers(lastCtx);
          releaseServiceLock(paths.lockFile);
          if (cfg && cfg.enabled && cfg.autoStart && cfg.apiBaseUrl && !isPaused(paths.pauseFile)) {
            try {
              ensureWorkersRunning(lastCtx);
            } catch (err) {
              return { text: `token rotate restart failed: ${String(err)}` };
            }
          }
          return { text: "proofwork-worker token rotated (will re-register on next start)" };
        }

        if (verb === "browser" && rest[0]?.toLowerCase() === "reset") {
          if (!cfg) return { text: "missing config" };
          try {
            const specsNow = computeWorkerSpecs(lastCtx, cfg);
            const profiles = Array.from(new Set(specsNow.map((s) => s.cfg.browserProfile).filter(Boolean)));
            for (const profile of profiles) {
              const p = spawn(cfg.openclawBin, ["browser", "--browser-profile", profile, "reset-profile", "--json"], {
                env: process.env,
                stdio: ["ignore", "pipe", "pipe"],
              });
              await new Promise<void>((resolve) => p.on("close", () => resolve()));
            }
            return { text: `browser profiles reset: ${profiles.join(", ")}` };
          } catch (err) {
            return { text: `browser reset failed: ${String(err)}` };
          }
        }

        if (verb === "debug") {
          const on = (rest[0] ?? "").toLowerCase() === "on";
          writeFileAtomic(path.join(paths.root, "debug.flag"), on ? "1\n" : "0\n", 0o600);
          await stopAllWorkers(lastCtx);
          releaseServiceLock(paths.lockFile);
          if (cfg && cfg.enabled && cfg.autoStart && cfg.apiBaseUrl && !isPaused(paths.pauseFile)) {
            try {
              ensureWorkersRunning(lastCtx);
            } catch (err) {
              return { text: `debug restart failed: ${String(err)}` };
            }
          }
          return { text: `debug ${on ? "on" : "off"}` };
        }

        return { text: "usage: /proofwork status|pause|resume|token rotate|browser reset|debug on|off|payout ...|payouts [status] [page] [limit]|earnings" };
      },
    });
  },
};
