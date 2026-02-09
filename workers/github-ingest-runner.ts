// Load .env only in non-test environments
const _loadEnv =
  process.env.NODE_ENV !== 'test' && !process.env.VITEST
    ? import('dotenv/config').catch(() => {})
    : Promise.resolve();
await _loadEnv;

import { runMigrations } from '../src/db/migrate.js';
import { startWorkerHealthServer } from './health.js';
import { getGithubSource, putGithubEventRaw, upsertGithubRepo, upsertGithubSource } from '../src/store.js';
import { gunzipSync } from 'node:zlib';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseJsonSafe(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function maxNumericString(a: string | null, b: string | null): string | null {
  const aa = String(a ?? '').trim();
  const bb = String(b ?? '').trim();
  if (!aa) return bb || null;
  if (!bb) return aa || null;
  if (/^\d+$/.test(aa) && /^\d+$/.test(bb)) {
    try {
      return BigInt(aa) >= BigInt(bb) ? aa : bb;
    } catch {
      // fall through
    }
  }
  return aa >= bb ? aa : bb;
}

export type GithubIngestSourceKind = 'events_api' | 'gh_archive';

export async function runGithubIngestOnce(input: {
  sourceId: string;
  sourceKind: GithubIngestSourceKind;
  baseUrl: string;
  token?: string | null;
  // gh_archive-only: ingest this exact GH Archive hour string ("YYYY-MM-DD-H").
  // If omitted, we use the persisted cursor or derive from `now`.
  archiveHour?: string | null;
  maxEvents?: number;
  now?: Date;
}): Promise<{ fetched: number; upsertedRepos: number; cursor: Record<string, unknown> }> {
  const now = input.now ?? new Date();
  const baseUrl = String(input.baseUrl ?? '').trim().replace(/\/$/, '');
  if (!baseUrl) throw new Error('github_ingest_missing_base_url');

  // Ensure a source row exists (cursor is best-effort).
  const existing = await getGithubSource(input.sourceId);
  if (!existing) await upsertGithubSource({ id: input.sourceId, cursor: {}, status: 'active' });

  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  const t = String(input.token ?? '').trim();
  if (t) headers.Authorization = `Bearer ${t}`;

  let lastEventId: string | null = null;
  let lastEventCreatedAt: string | null = null;
  let upsertedRepos = 0;
  let fetched = 0;

  async function ingestEvents(events: any[]) {
    fetched += events.length;
    for (const e of events) {
    const eventId = String((e as any)?.id ?? '').trim();
    const eventType = String((e as any)?.type ?? '').trim();
    if (!eventId || !eventType) continue;

    const createdAtRaw = String((e as any)?.created_at ?? '').trim();
    const actorLogin = String((e as any)?.actor?.login ?? '').trim() || null;
    const repoId = Number((e as any)?.repo?.id ?? NaN);
    const repoFullName = String((e as any)?.repo?.name ?? '').trim() || null;

    const createdAt = createdAtRaw ? new Date(createdAtRaw) : null;
    if (createdAt && Number.isNaN(createdAt.getTime())) {
      // keep it null rather than store an invalid timestamp
    }

    await putGithubEventRaw({
      eventId,
      source: input.sourceId,
      eventType,
      eventCreatedAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
      repoFullName,
      actorLogin,
      payload: (e as any) ?? {},
    });

    lastEventId = maxNumericString(lastEventId, eventId);
    if (createdAtRaw) lastEventCreatedAt = createdAtRaw;

    if (Number.isFinite(repoId) && repoId > 0 && repoFullName) {
      await upsertGithubRepo({
        repoId: Math.floor(repoId),
        fullName: repoFullName,
        htmlUrl: `https://github.com/${repoFullName}`,
        description: null,
        language: null,
        topics: [],
        licenseSpdx: null,
        licenseKey: null,
        stars: 0,
        forks: 0,
        archived: false,
        pushedAt: null,
        updatedAt: null,
        seenAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : now,
      });
      upsertedRepos += 1;
    }
    }
  }

  if (input.sourceKind === 'events_api') {
    const url = new URL(`${baseUrl}/events`);
    url.searchParams.set('per_page', String(Math.max(1, Math.min(100, input.maxEvents ?? 100))));

    const resp = await fetch(url.toString(), { method: 'GET', headers });
    const txt = await resp.text();
    if (!resp.ok) {
      await upsertGithubSource({
        id: input.sourceId,
        status: 'error',
        lastErrorAt: now,
        lastError: `events_api_fetch_failed:${resp.status}:${String(txt || '').slice(0, 300)}`,
      });
      throw new Error(`events_api_fetch_failed:${resp.status}`);
    }

    const json = parseJsonSafe(txt);
    if (!Array.isArray(json)) {
      await upsertGithubSource({
        id: input.sourceId,
        status: 'error',
        lastErrorAt: now,
        lastError: 'events_api_invalid_json',
      });
      throw new Error('events_api_invalid_json');
    }

    await ingestEvents(json);
  } else if (input.sourceKind === 'gh_archive') {
    const cursorPrev = (existing?.cursor_json ?? {}) as any;
    const explicit = String(input.archiveHour ?? '').trim() || null;
    const hour = explicit || String(cursorPrev?.nextHour ?? '').trim() || null;
    if (!hour) {
      // Derive a stable start hour from now (previous hour) to avoid "future hour" 404 loops.
      const d = new Date(now);
      d.setUTCMinutes(0, 0, 0);
      d.setUTCHours(d.getUTCHours() - 1);
      const derived = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}-${d.getUTCHours()}`;
      await upsertGithubSource({ id: input.sourceId, cursor: { kind: 'gh_archive', nextHour: derived }, status: 'active' });
      return { fetched: 0, upsertedRepos: 0, cursor: { kind: 'gh_archive', nextHour: derived } };
    }

    const url = `${baseUrl}/${hour}.json.gz`;
    const resp = await fetch(url, { method: 'GET', headers: { Accept: 'application/gzip' } });
    if (resp.status === 404) {
      // Not yet available. Keep cursor unchanged but record a soft error.
      await upsertGithubSource({
        id: input.sourceId,
        status: 'active',
        lastErrorAt: now,
        lastError: `gh_archive_not_ready:${hour}`,
      });
      return { fetched: 0, upsertedRepos: 0, cursor: { kind: 'gh_archive', nextHour: hour } };
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!resp.ok) {
      await upsertGithubSource({
        id: input.sourceId,
        status: 'error',
        lastErrorAt: now,
        lastError: `gh_archive_fetch_failed:${resp.status}:${hour}`,
      });
      throw new Error(`gh_archive_fetch_failed:${resp.status}`);
    }

    const raw = gunzipSync(buf).toString('utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const events = lines.map(parseJsonSafe).filter(Boolean);
    await ingestEvents(events);

    // Advance cursor by one hour (UTC).
    const [yyyy, mm, dd, hh] = hour.split('-').map((x) => Number(x));
    const d = new Date(Date.UTC(yyyy, (mm ?? 1) - 1, dd ?? 1, hh ?? 0, 0, 0));
    d.setUTCHours(d.getUTCHours() + 1);
    const nextHour = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}-${d.getUTCHours()}`;

    const cursor: Record<string, unknown> = { kind: 'gh_archive', nextHour, lastIngestedHour: hour, lastPollAt: now.toISOString() };
    await upsertGithubSource({ id: input.sourceId, cursor, status: 'active', lastSuccessAt: now, lastErrorAt: null, lastError: null });
    return { fetched, upsertedRepos, cursor };
  } else {
    throw new Error(`unsupported_source_kind:${input.sourceKind}`);
  }

  const cursor: Record<string, unknown> = {
    kind: input.sourceKind,
    lastEventId,
    lastEventCreatedAt,
    lastPollAt: now.toISOString(),
  };

  await upsertGithubSource({
    id: input.sourceId,
    cursor,
    status: 'active',
    lastSuccessAt: now,
    lastErrorAt: null,
    lastError: null,
  });

  return { fetched, upsertedRepos, cursor };
}

if (process.env.NODE_ENV !== 'test' && import.meta.url === `file://${process.argv[1]}`) {
  const sourceId = String(process.env.GITHUB_INGEST_SOURCE_ID ?? 'events_api').trim() || 'events_api';
  const baseUrl = String(process.env.GITHUB_API_BASE_URL ?? 'https://api.github.com').trim() || 'https://api.github.com';
  const token = String(process.env.GITHUB_TOKEN ?? '').trim() || null;
  const sourceKind = (String(process.env.GITHUB_INGEST_SOURCE_KIND ?? 'events_api').trim() as GithubIngestSourceKind) || 'events_api';
  const pollMsRaw = Number(process.env.GITHUB_INGEST_POLL_MS ?? 60_000);
  const pollMs = Number.isFinite(pollMsRaw) ? Math.max(250, Math.min(10 * 60_000, Math.floor(pollMsRaw))) : 60_000;

  let lastOkAt: number | null = null;
  let lastErr: string | null = null;

  (async () => {
    await runMigrations();
    await startWorkerHealthServer({
      name: 'github-ingest',
      portEnv: 'GITHUB_INGEST_HEALTH_PORT',
      defaultPort: 9106,
      getStatus: () => ({ lastOkAt, lastErr, sourceId, baseUrl }),
    });

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await runGithubIngestOnce({ sourceId, sourceKind, baseUrl, token });
        lastOkAt = Date.now();
        lastErr = null;
      } catch (err: any) {
        lastErr = String(err?.message ?? err);
        console.error('[github-ingest] error', lastErr);
      }
      await sleep(pollMs);
    }
  })().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
