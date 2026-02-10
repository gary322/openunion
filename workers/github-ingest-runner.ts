// Load .env only in non-test environments
const _loadEnv =
  process.env.NODE_ENV !== 'test' && !process.env.VITEST
    ? import('dotenv/config').catch(() => {})
    : Promise.resolve();
await _loadEnv;

import { runMigrations } from '../src/db/migrate.js';
import { startWorkerHealthServer } from './health.js';
import { getGithubSource, pruneGithubEventsRaw, putGithubEventRaw, upsertGithubRepo, upsertGithubSource } from '../src/store.js';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

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

export type GithubIngestSourceKind = 'events_api' | 'gh_archive' | 'hybrid';

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

  async function ingestEvent(e: any) {
    if (!e || typeof e !== 'object') return;
    const eventId = String((e as any)?.id ?? '').trim();
    const eventType = String((e as any)?.type ?? '').trim();
    if (!eventId || !eventType) return;

    const createdAtRaw = String((e as any)?.created_at ?? '').trim();
    const actorLogin = String((e as any)?.actor?.login ?? '').trim() || null;
    const repoId = Number((e as any)?.repo?.id ?? NaN);
    const repoFullName = String((e as any)?.repo?.name ?? '').trim() || null;

    let eventCreatedAt: Date | null = null;
    if (createdAtRaw) {
      const d = new Date(createdAtRaw);
      if (!Number.isNaN(d.getTime())) eventCreatedAt = d;
    }

    await putGithubEventRaw({
      eventId,
      source: input.sourceId,
      eventType,
      eventCreatedAt,
      repoFullName,
      actorLogin,
      payload: (e as any) ?? {},
    });

    fetched += 1;
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
        seenAt: eventCreatedAt ?? now,
      });
      upsertedRepos += 1;
    }
  }

  async function ingestEvents(events: any[]) {
    for (const e of events) await ingestEvent(e);
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
    if (!resp.ok) {
      await upsertGithubSource({
        id: input.sourceId,
        status: 'error',
        lastErrorAt: now,
        lastError: `gh_archive_fetch_failed:${resp.status}:${hour}`,
      });
      throw new Error(`gh_archive_fetch_failed:${resp.status}`);
    }

    // Stream-decompress and ingest line-by-line to avoid OOM on large archive hours.
    const body = resp.body;
    if (!body) throw new Error('gh_archive_missing_body');
    const gunzip = createGunzip();
    const nodeStream = Readable.fromWeb(body as any);
    const rl = createInterface({ input: nodeStream.pipe(gunzip), crlfDelay: Infinity });

    for await (const line of rl) {
      const s = String(line ?? '').trim();
      if (!s) continue;
      const evt = parseJsonSafe(s);
      if (!evt) continue;
      await ingestEvent(evt);
    }

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
  const rootSourceId = String(process.env.GITHUB_INGEST_SOURCE_ID ?? 'hybrid').trim() || 'hybrid';
  const eventsBaseUrl = String(process.env.GITHUB_EVENTS_API_BASE_URL ?? process.env.GITHUB_API_BASE_URL ?? 'https://api.github.com')
    .trim()
    .replace(/\/$/, '') || 'https://api.github.com';
  const archiveBaseUrl = String(process.env.GITHUB_GH_ARCHIVE_BASE_URL ?? 'https://data.gharchive.org')
    .trim()
    .replace(/\/$/, '') || 'https://data.gharchive.org';
  const token = String(process.env.GITHUB_TOKEN ?? '').trim() || null;
  const sourceKindRaw = String(process.env.GITHUB_INGEST_SOURCE_KIND ?? 'hybrid').trim() || 'hybrid';
  const sourceKind = sourceKindRaw as GithubIngestSourceKind;
  const pollMsRaw = Number(process.env.GITHUB_INGEST_POLL_MS ?? 60_000);
  const pollMs = Number.isFinite(pollMsRaw) ? Math.max(250, Math.min(10 * 60_000, Math.floor(pollMsRaw))) : 60_000;

  const archivePollMsRaw = Number(process.env.GITHUB_INGEST_ARCHIVE_POLL_MS ?? 300_000);
  const archivePollMs = Number.isFinite(archivePollMsRaw)
    ? Math.max(5_000, Math.min(60 * 60_000, Math.floor(archivePollMsRaw)))
    : 300_000;

  const ttlDaysRaw = Number(process.env.GITHUB_EVENTS_RAW_TTL_DAYS ?? 14);
  const ttlDays = Number.isFinite(ttlDaysRaw) ? Math.max(1, Math.min(365, Math.floor(ttlDaysRaw))) : 14;
  const pruneLimitRaw = Number(process.env.GITHUB_EVENTS_RAW_PRUNE_LIMIT ?? 10_000);
  const pruneLimit = Number.isFinite(pruneLimitRaw) ? Math.max(1, Math.min(100_000, Math.floor(pruneLimitRaw))) : 10_000;
  const pruneIntervalMsRaw = Number(process.env.GITHUB_EVENTS_RAW_PRUNE_INTERVAL_MS ?? 60 * 60_000);
  const pruneIntervalMs = Number.isFinite(pruneIntervalMsRaw)
    ? Math.max(60_000, Math.min(24 * 60 * 60_000, Math.floor(pruneIntervalMsRaw)))
    : 60 * 60_000;

  let lastOkAt: number | null = null;
  let lastErr: string | null = null;
  let lastArchivePollAt = 0;
  let lastPruneAt = 0;

  (async () => {
    await runMigrations();
    await startWorkerHealthServer({
      name: 'github-ingest',
      portEnv: 'GITHUB_INGEST_HEALTH_PORT',
      defaultPort: 9106,
      getStatus: () => ({
        lastOkAt,
        lastErr,
        sourceKind,
        rootSourceId,
        eventsBaseUrl,
        archiveBaseUrl,
        ttlDays,
      }),
    });

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now = Date.now();
      let okThisLoop = false;

      if (sourceKind === 'hybrid') {
        const eventsSourceId = String(process.env.GITHUB_INGEST_EVENTS_SOURCE_ID ?? `${rootSourceId}:events`).trim() || `${rootSourceId}:events`;
        const archiveSourceId = String(process.env.GITHUB_INGEST_ARCHIVE_SOURCE_ID ?? `${rootSourceId}:archive`).trim() || `${rootSourceId}:archive`;

        try {
          await runGithubIngestOnce({ sourceId: eventsSourceId, sourceKind: 'events_api', baseUrl: eventsBaseUrl, token });
          okThisLoop = true;
          lastErr = null;
        } catch (err: any) {
          lastErr = String(err?.message ?? err);
          console.error('[github-ingest] events_api error', lastErr);
        }

        if (now - lastArchivePollAt >= archivePollMs) {
          lastArchivePollAt = now;
          try {
            await runGithubIngestOnce({ sourceId: archiveSourceId, sourceKind: 'gh_archive', baseUrl: archiveBaseUrl });
            okThisLoop = true;
            lastErr = null;
          } catch (err: any) {
            lastErr = String(err?.message ?? err);
            console.error('[github-ingest] gh_archive error', lastErr);
          }
        }
      } else {
        const baseUrl = sourceKind === 'gh_archive' ? archiveBaseUrl : eventsBaseUrl;
        try {
          await runGithubIngestOnce({ sourceId: rootSourceId, sourceKind, baseUrl, token });
          okThisLoop = true;
          lastErr = null;
        } catch (err: any) {
          lastErr = String(err?.message ?? err);
          console.error('[github-ingest] error', lastErr);
        }
      }

      if (ttlDays > 0 && now - lastPruneAt >= pruneIntervalMs) {
        lastPruneAt = now;
        try {
          const deleted = await pruneGithubEventsRaw({ maxAgeDays: ttlDays, limit: pruneLimit });
          if (deleted > 0) console.log(`[github-ingest] pruned_github_events_raw deleted=${deleted} ttlDays=${ttlDays}`);
        } catch (err: any) {
          const msg = String(err?.message ?? err);
          console.error('[github-ingest] prune error', msg);
        }
      }

      if (okThisLoop) lastOkAt = Date.now();
      await sleep(pollMs);
    }
  })().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
