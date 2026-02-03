import { nanoid } from 'nanoid';
import { sha256 } from './utils.js';
import { db } from './db/client.js';
import { hmacSha256Hex } from './auth/tokens.js';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { lookup, resolveTxt } from 'node:dns/promises';
import { isIP } from 'node:net';

export type OrgRole = 'owner' | 'admin' | 'editor' | 'viewer';
export interface User {
  id: string;
  email: string;
  passwordHash: string;
  orgId: string;
  role: OrgRole;
}

export interface Origin {
  id: string;
  orgId: string;
  origin: string;
  status: 'unverified' | 'pending' | 'verified' | 'failed' | 'revoked';
  method: 'dns_txt' | 'http_file' | 'header';
  token: string;
  verifiedAt?: number;
  failureReason?: string;
}

export interface OrgApiKey {
  id: string;
  orgId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  revokedAt?: number;
}

const DEMO_ORG_ID = 'org_demo';
const DEMO_USER_EMAIL = 'buyer@example.com';
const BUYER_TOKEN_PEPPER = process.env.BUYER_TOKEN_PEPPER ?? process.env.WORKER_TOKEN_PEPPER ?? 'dev_pepper_change_me';
if (process.env.NODE_ENV === 'production' && BUYER_TOKEN_PEPPER === 'dev_pepper_change_me') {
  throw new Error('BUYER_TOKEN_PEPPER must be set in production');
}

// Password hashing (production-safe)
//
// We keep backward compatibility with legacy SHA-256 hashes used in early demos/tests.
// New registrations use scrypt with a random salt.
const SCRYPT_N = 1 << 14; // 16384
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

function verifyPasswordHash(password: string, stored: string): boolean {
  const raw = String(stored ?? '');
  if (raw.startsWith('scrypt$')) {
    const parts = raw.split('$');
    if (parts.length !== 6) return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const saltB64 = parts[4];
    const hashB64 = parts[5];
    if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = scryptSync(password, salt, expected.length, { N: n, r, p });
    // timingSafeEqual throws if lengths differ; guard.
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  }

  // Legacy demo/test format: sha256(password)
  return raw === sha256(password);
}

function originFromRow(row: any): Origin {
  return {
    id: row.id,
    orgId: row.org_id,
    origin: row.origin,
    status: row.status,
    method: row.method,
    token: row.token,
    verifiedAt: row.verified_at ? row.verified_at.getTime() : undefined,
    failureReason: row.failure_reason ?? undefined,
  };
}

function originVerifierAllowPrivateNetworks(): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  const v = String(process.env.ORIGIN_VERIFIER_ALLOW_PRIVATE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function isPrivateOrSpecialIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;

  // RFC1918 private + loopback + link-local + multicast + reserved + TEST-NET ranges.
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 192 && b === 88) return true; // 192.88.99.0/24 (6to4 relay, deprecated but non-global)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
  if (a === 192 && b === 2) return true; // TEST-NET-1
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a >= 224) return true;
  return false;
}

function isPrivateOrSpecialIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  // Unique local (fc00::/7), link-local (fe80::/10)
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
  // IPv4-mapped or translated; treat as special and re-check IPv4 portion.
  const m = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m?.[1]) return isPrivateOrSpecialIpv4(m[1]);
  return false;
}

function isPrivateOrSpecialIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateOrSpecialIpv4(ip);
  if (kind === 6) return isPrivateOrSpecialIpv6(ip);
  return true;
}

async function assertOriginHostIsPublic(origin: string): Promise<void> {
  if (originVerifierAllowPrivateNetworks()) return;
  const u = new URL(origin);
  const host = u.hostname;
  if (!host) throw new Error('invalid_origin_host');
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) throw new Error('origin_host_private');
  if (isIP(host)) {
    if (isPrivateOrSpecialIp(host)) throw new Error('origin_host_private');
    return;
  }

  const res = await lookup(host, { all: true });
  if (!Array.isArray(res) || res.length === 0) throw new Error('origin_host_dns_failed');
  for (const rec of res) {
    if (!rec?.address) continue;
    if (isPrivateOrSpecialIp(String(rec.address))) throw new Error('origin_host_private');
  }
}

async function readBodyLimited(resp: Response, maxBytes: number): Promise<Buffer> {
  const len = resp.headers.get('content-length');
  if (len && Number.isFinite(Number(len)) && Number(len) > maxBytes) {
    resp.body?.cancel?.();
    throw new Error('origin_verify_body_too_large');
  }

  const reader = resp.body?.getReader?.();
  if (!reader) return Buffer.from(await resp.arrayBuffer());

  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const buf = Buffer.from(value);
    total += buf.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('origin_verify_body_too_large');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function verifyOriginProof(input: { origin: string; method: Origin['method']; token: string }): Promise<{ ok: true } | { ok: false; reason: string }> {
  const origin = String(input.origin);
  const method = input.method;
  const token = String(input.token);
  if (!origin || !token) return { ok: false, reason: 'invalid_origin_or_token' };

  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return { ok: false, reason: 'invalid_origin' };
  }
  if (!['http:', 'https:'].includes(u.protocol)) return { ok: false, reason: 'invalid_origin_protocol' };
  if (u.username || u.password) return { ok: false, reason: 'invalid_origin_credentials' };

  const timeoutMs = Number(process.env.ORIGIN_VERIFIER_TIMEOUT_MS ?? 5000);
  const maxBytes = Number(process.env.ORIGIN_VERIFIER_MAX_BYTES ?? 8192);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await assertOriginHostIsPublic(origin);

    if (method === 'dns_txt') {
      // Expected: TXT record at _proofwork.<host> contains the token.
      // Example: _proofwork.example.com TXT "pw_verify_..."
      const name = `_proofwork.${u.hostname}`;
      const txt = await resolveTxt(name);
      for (const rec of txt) {
        const joined = rec.join('');
        if (joined.includes(token)) return { ok: true };
      }
      return { ok: false, reason: 'dns_txt_missing_token' };
    }

    if (method === 'http_file') {
      // Expected: https://<origin>/.well-known/proofwork-verify.txt contains the token.
      const verifyUrl = new URL('/.well-known/proofwork-verify.txt', origin).toString();
      const resp = await fetch(verifyUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': 'proofwork-origin-verifier/1.0' },
      });
      if (!resp.ok) return { ok: false, reason: `http_file_bad_status:${resp.status}` };
      const body = await readBodyLimited(resp, maxBytes);
      const text = body.toString('utf8');
      if (!text.includes(token)) return { ok: false, reason: 'http_file_missing_token' };
      return { ok: true };
    }

    if (method === 'header') {
      // Expected: https://<origin>/ responds with header X-Proofwork-Verify: <token> (or includes token).
      const verifyUrl = new URL('/', origin).toString();
      const resp = await fetch(verifyUrl, {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': 'proofwork-origin-verifier/1.0' },
      });
      resp.body?.cancel?.();
      if (!resp.ok) return { ok: false, reason: `header_bad_status:${resp.status}` };
      const h =
        resp.headers.get('x-proofwork-verify') ??
        resp.headers.get('x-proofwork-verification') ??
        resp.headers.get('x-proofwork-verify-token');
      if (!h) return { ok: false, reason: 'header_missing' };
      if (!String(h).includes(token)) return { ok: false, reason: 'header_missing_token' };
      return { ok: true };
    }

    return { ok: false, reason: 'unknown_method' };
  } catch (err: any) {
    const msg = String(err?.name ?? '').includes('Abort') ? 'origin_verify_timeout' : String(err?.message ?? err);
    return { ok: false, reason: msg };
  } finally {
    clearTimeout(t);
  }
}

export async function seedBuyer() {
  // Ensure demo org exists
  await db
    .insertInto('orgs')
    .values({ id: DEMO_ORG_ID, name: 'Demo Org', platform_fee_bps: 0, platform_fee_wallet_address: null, created_at: new Date() })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  const existingUser = await db.selectFrom('org_users').select(['id']).where('email', '=', DEMO_USER_EMAIL).executeTakeFirst();
  if (!existingUser) {
    await db
      .insertInto('org_users')
      .values({
        id: nanoid(8),
        email: DEMO_USER_EMAIL,
        password_hash: sha256('password'),
        org_id: DEMO_ORG_ID,
        role: 'owner',
        created_at: new Date(),
      })
      .execute();
  }

  // Seed verified origins to satisfy demo bounty constraints
  const seedOrigins = ['https://example.com', 'https://app.example.com'];
  for (const o of seedOrigins) {
    const normalized = normalizeOrigin(o);
    const exists = await db
      .selectFrom('origins')
      .select(['id'])
      .where('org_id', '=', DEMO_ORG_ID)
      .where('origin', '=', normalized)
      .executeTakeFirst();
    if (exists) continue;
    await db
      .insertInto('origins')
      .values({
        id: nanoid(10),
        org_id: DEMO_ORG_ID,
        origin: normalized,
        status: 'verified',
        method: 'dns_txt',
        token: 'seed',
        verified_at: new Date(),
        failure_reason: null,
        created_at: new Date(),
      })
      .execute();
  }
}

export async function verifyPassword(email: string, pwd: string) {
  const normalizedEmail = normalizeEmail(email);
  const user = await db.selectFrom('org_users').selectAll().where('email', '=', normalizedEmail).executeTakeFirst();
  if (!user) return undefined;
  if (!verifyPasswordHash(pwd, user.password_hash)) return undefined;
  return { id: user.id, email: user.email, passwordHash: user.password_hash, orgId: user.org_id, role: user.role as OrgRole } satisfies User;
}

export async function registerOrg(input: {
  orgName: string;
  email: string;
  password: string;
}): Promise<{ orgId: string; userId: string; email: string; role: OrgRole }> {
  const orgName = String(input.orgName ?? '').trim();
  const email = normalizeEmail(String(input.email ?? ''));
  const password = String(input.password ?? '');

  if (!orgName || orgName.length < 2 || orgName.length > 80) throw new Error('invalid_org_name');
  if (!email || !email.includes('@') || email.length > 200) throw new Error('invalid_email');
  if (!password || password.length < 8 || password.length > 200) throw new Error('invalid_password');

  const orgId = `org_${nanoid(10)}`;
  const userId = nanoid(8);

  const existing = await db.selectFrom('org_users').select(['id']).where('email', '=', email).executeTakeFirst();
  if (existing) throw new Error('email_already_registered');

  const now = new Date();
  await db
    .insertInto('orgs')
    .values({ id: orgId, name: orgName, platform_fee_bps: 0, platform_fee_wallet_address: null, created_at: now })
    .execute();

  await db
    .insertInto('org_users')
    .values({
      id: userId,
      email,
      password_hash: hashPassword(password),
      org_id: orgId,
      role: 'owner',
      created_at: now,
    })
    .execute();

  return { orgId, userId, email, role: 'owner' };
}

export async function createOrgApiKey(orgId: string, name: string) {
  const id = nanoid(10);
  const full = `pw_bu_${nanoid(16)}`;
  const keyPrefix = full.slice(0, 12);
  const rec: OrgApiKey = { id, orgId, name, keyPrefix, keyHash: hmacSha256Hex(full, BUYER_TOKEN_PEPPER) };

  await db
    .insertInto('org_api_keys')
    .values({
      id,
      org_id: orgId,
      name,
      key_prefix: rec.keyPrefix,
      key_hash: rec.keyHash,
      revoked_at: null,
      created_at: new Date(),
    })
    .execute();

  return { apiKey: rec, token: full };
}

export async function getApiKey(token: string) {
  const prefix = token.slice(0, 12);
  const keyHashPeppered = hmacSha256Hex(token, BUYER_TOKEN_PEPPER);
  const keyHashLegacy = sha256(token);
  const rec = await db
    .selectFrom('org_api_keys')
    .selectAll()
    .where('key_prefix', '=', prefix)
    .where('key_hash', 'in', [keyHashPeppered, keyHashLegacy])
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (!rec) return undefined;
  return {
    id: rec.id,
    orgId: rec.org_id,
    name: rec.name,
    keyPrefix: rec.key_prefix,
    keyHash: rec.key_hash,
    revokedAt: rec.revoked_at ? rec.revoked_at.getTime() : undefined,
  } satisfies OrgApiKey;
}

export async function listOrigins(orgId: string) {
  const rows = await db.selectFrom('origins').selectAll().where('org_id', '=', orgId).orderBy('created_at', 'desc').execute();
  return rows.map(originFromRow);
}

export async function addOrigin(orgId: string, origin: string, method: Origin['method']) {
  const id = nanoid(10);
  const token = `pw_verify_${nanoid(12)}`;
  const rec: Origin = { id, orgId, origin: normalizeOrigin(origin), status: 'pending', method, token };

  await db
    .insertInto('origins')
    .values({
      id,
      org_id: orgId,
      origin: rec.origin,
      status: rec.status,
      method: rec.method,
      token: rec.token,
      verified_at: null,
      failure_reason: null,
      created_at: new Date(),
    })
    .execute();

  return rec;
}

export async function checkOrigin(id: string) {
  const row = await db.selectFrom('origins').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) return undefined;

  if (row.status === 'pending') {
    const check = await verifyOriginProof({ origin: row.origin, method: row.method, token: row.token });
    if (check.ok) {
      const updated = await db
        .updateTable('origins')
        .set({ status: 'verified', verified_at: new Date(), failure_reason: null })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return originFromRow(updated);
    }

    const updated = await db
      .updateTable('origins')
      .set({ status: 'pending', failure_reason: check.reason })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return originFromRow(updated);
  }

  return originFromRow(row);
}

export async function revokeOrigin(id: string) {
  const updated = await db.updateTable('origins').set({ status: 'revoked' }).where('id', '=', id).returningAll().executeTakeFirst();
  return updated ? originFromRow(updated) : undefined;
}

export async function originAllowed(orgId: string, candidate: string) {
  let o: string;
  try {
    o = normalizeOrigin(candidate);
  } catch {
    return false;
  }

  const verified = await db
    .selectFrom('origins')
    .select(['origin'])
    .where('org_id', '=', orgId)
    .where('status', '=', 'verified')
    .execute();
  return verified.some((rec) => o === rec.origin);
}

export function normalizeOrigin(input: string) {
  const url = new URL(input);
  if (url.username || url.password) throw new Error('invalid_origin');
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid_origin');
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('https_required');
  return url.origin;
}
