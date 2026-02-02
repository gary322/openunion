import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { nanoid } from 'nanoid';
import { db } from '../db/client.js';

const SESSION_SECRET = process.env.SESSION_SECRET ?? 'dev_session_secret_change_me';
if (process.env.NODE_ENV === 'production' && SESSION_SECRET === 'dev_session_secret_change_me') {
  throw new Error('SESSION_SECRET must be set in production');
}

export function signSessionId(sessionId: string) {
  return createHmac('sha256', SESSION_SECRET).update(sessionId).digest('hex');
}

export function verifySessionCookie(cookieValue: string) {
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return undefined;
  const [id, sig] = parts;
  const expected = signSessionId(id);
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return undefined;
  if (!timingSafeEqual(a, b)) return undefined;
  return id;
}

export function newCsrfSecret() {
  return randomBytes(32).toString('hex');
}

export function csrfToken(csrfSecret: string) {
  // double-submit token: HMAC(secret, "csrf") to avoid exposing secret
  return createHmac('sha256', csrfSecret).update('csrf').digest('hex');
}

export async function createSession(input: { userId: string; orgId: string; role: string; ttlSec?: number }) {
  const ttlSec = input.ttlSec ?? 7 * 24 * 3600;
  const id = nanoid(24);
  const csrfSecret = newCsrfSecret();
  const now = new Date();
  const expiresAt = new Date(Date.now() + ttlSec * 1000);

  await db
    .insertInto('sessions')
    .values({
      id,
      user_id: input.userId,
      org_id: input.orgId,
      role: input.role,
      csrf_secret: csrfSecret,
      created_at: now,
      expires_at: expiresAt,
      revoked_at: null,
    })
    .execute();

  return { id, csrfSecret, expiresAt, cookieValue: `${id}.${signSessionId(id)}` };
}

export async function getSession(id: string) {
  const row = await db.selectFrom('sessions').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) return undefined;
  if (row.revoked_at) return undefined;
  if (row.expires_at && (row.expires_at as any as Date).getTime() < Date.now()) return undefined;
  return {
    id: row.id,
    userId: row.user_id,
    orgId: row.org_id,
    role: row.role,
    csrfSecret: row.csrf_secret,
    expiresAt: row.expires_at as any as Date,
  };
}

export async function revokeSession(id: string) {
  await db.updateTable('sessions').set({ revoked_at: new Date() }).where('id', '=', id).execute();
}

