import { sql } from 'kysely';
import { db } from '../db/client.js';

// Normalize admin-provided blocked domain input into a bare hostname (no scheme/path).
// Supports inputs like:
// - "example.com"
// - "*.example.com"
// - "https://example.com/path"
// - "example.com:443"
export function normalizeBlockedDomainInput(input: string): string {
  let s = String(input ?? '').trim().toLowerCase();
  if (!s) throw new Error('invalid_blocked_domain');

  // Accept URL-like inputs.
  if (s.includes('://')) {
    try {
      const u = new URL(s);
      s = u.hostname.toLowerCase();
    } catch {
      throw new Error('invalid_blocked_domain');
    }
  } else {
    // Accept bare host[:port] inputs by parsing as https://<host>.
    try {
      const u = new URL(`https://${s}`);
      s = u.hostname.toLowerCase();
    } catch {
      throw new Error('invalid_blocked_domain');
    }
  }

  if (s.startsWith('*.')) s = s.slice(2);
  if (s.startsWith('.')) s = s.slice(1);
  s = s.replace(/\.$/, '');

  if (!s || s.length > 200) throw new Error('invalid_blocked_domain');
  return s;
}

export function hostnameFromUrl(input: string): string {
  const u = new URL(input);
  return u.hostname.toLowerCase();
}

export async function isHostnameBlocked(hostname: string): Promise<boolean> {
  const host = String(hostname ?? '').trim().toLowerCase();
  if (!host) return false;

  // Match exact hostname or any subdomain of a blocked domain.
  const row = await db
    .selectFrom('blocked_domains')
    .select(['id'])
    .where(sql<boolean>`${host} = domain OR ${host} LIKE '%.' || domain`)
    .limit(1)
    .executeTakeFirst();
  return Boolean(row?.id);
}

export async function assertUrlNotBlocked(inputUrl: string): Promise<void> {
  let host: string;
  try {
    host = hostnameFromUrl(inputUrl);
  } catch {
    // Invalid URLs should be handled by the caller's validation.
    return;
  }
  if (await isHostnameBlocked(host)) {
    throw new Error(`blocked_domain:${host}`);
  }
}

