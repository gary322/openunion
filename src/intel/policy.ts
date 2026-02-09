import { createHash } from 'node:crypto';

export type IntelPolicyMode = 'suggest' | 'auto_apply';

export type IntelPolicyDecision = { allowed: true } | { allowed: false; code: string; message: string };

function normalizeLicenseId(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  return s.toUpperCase();
}

export function readPolicyVersion(): string {
  // Policy version is derived from the relevant env knobs so clients can cache safely.
  const allow = String(process.env.INTEL_LICENSE_ALLOWLIST ?? '').trim();
  const deny = String(process.env.INTEL_LICENSE_DENYLIST ?? '').trim();
  const minStars = String(process.env.INTEL_MIN_STARS_DEFAULT ?? '').trim();
  const blob = JSON.stringify({ allow, deny, minStars });
  return createHash('sha256').update(blob).digest('hex').slice(0, 12);
}

export function parseCsvUpper(v: string | null | undefined): Set<string> {
  const s = String(v ?? '').trim();
  if (!s) return new Set();
  return new Set(
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => x.toUpperCase())
  );
}

export function decideRepoPolicy(input: {
  mode: IntelPolicyMode;
  licenseSpdx: string | null;
  archived: boolean;
  stars: number;
  // Optional per-request allowlist: if provided, it overrides env allowlist for this decision.
  requestLicenseAllow?: string[] | null;
  requestMinStars?: number | null;
}): IntelPolicyDecision {
  const license = normalizeLicenseId(input.licenseSpdx);

  // Repo state gating (simple, deterministic).
  if (input.archived) {
    return { allowed: false, code: 'policy_blocked_security', message: 'repo is archived' };
  }

  const reqMinStars = Number.isFinite(Number(input.requestMinStars)) ? Math.max(0, Math.floor(Number(input.requestMinStars))) : null;
  const envMinStarsRaw = Number(process.env.INTEL_MIN_STARS_DEFAULT ?? 0);
  const envMinStars = Number.isFinite(envMinStarsRaw) ? Math.max(0, Math.floor(envMinStarsRaw)) : 0;
  const minStars = reqMinStars ?? envMinStars;
  if (minStars > 0 && input.stars < minStars) {
    return { allowed: false, code: 'policy_blocked_quality', message: `repo stars below minStars=${minStars}` };
  }

  const deny = parseCsvUpper(process.env.INTEL_LICENSE_DENYLIST);

  const requestAllow = Array.isArray(input.requestLicenseAllow)
    ? new Set(input.requestLicenseAllow.map((x) => String(x).trim()).filter(Boolean).map((x) => x.toUpperCase()))
    : null;
  const envAllow = parseCsvUpper(process.env.INTEL_LICENSE_ALLOWLIST);
  const allow = requestAllow && requestAllow.size > 0 ? requestAllow : envAllow.size > 0 ? envAllow : null;

  // If explicitly denied, always block.
  if (license && deny.has(license)) {
    return { allowed: false, code: 'policy_blocked_license', message: `license denied: ${license}` };
  }

  if (input.mode === 'auto_apply') {
    // Auto-apply is stricter: require a known license and, if an allowlist is configured, require membership.
    if (!license) {
      return { allowed: false, code: 'policy_blocked_license', message: 'license unknown (auto-apply requires explicit license)' };
    }
    if (allow && !allow.has(license)) {
      return { allowed: false, code: 'policy_blocked_license', message: `license not allowlisted: ${license}` };
    }
    return { allowed: true };
  }

  // Suggest mode:
  // If request allowlist provided, filter strictly; otherwise allow unknown licenses but mark them for clients.
  if (allow) {
    if (!license) {
      return { allowed: false, code: 'policy_blocked_license', message: 'license unknown (allowlist enforced)' };
    }
    if (!allow.has(license)) {
      return { allowed: false, code: 'policy_blocked_license', message: `license not allowlisted: ${license}` };
    }
  }

  return { allowed: true };
}

