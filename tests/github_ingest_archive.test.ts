import { describe, it, expect, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { pool } from '../src/db/client.js';
import { resetStore } from '../src/store.js';
import { runGithubIngestOnce } from '../workers/github-ingest-runner.js';

function startStubGhArchiveServer(input: { hour: string; events: any[] }) {
  const body = input.events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const gz = gzipSync(Buffer.from(body, 'utf8'));

  const server = createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === `/${input.hour}.json.gz`) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/gzip');
      res.end(gz);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  return server;
}

describe('github ingest runner (gh_archive)', () => {
  beforeEach(async () => {
    await resetStore();
    await pool.query('TRUNCATE TABLE github_events_raw, github_repos, github_sources, intel_similarity_results, intel_similarity_queries, intel_provenance_manifests');
  });

  it('ingests an archive hour idempotently and advances cursor', async () => {
    const hour = '2026-02-09-0';
    const events = [
      {
        id: '101',
        type: 'PushEvent',
        created_at: '2026-02-09T00:10:00Z',
        actor: { login: 'alice' },
        repo: { id: 2001, name: 'proofwork/archive-repo-one' },
        payload: { distinct_size: 1 },
      },
      {
        id: '102',
        type: 'CreateEvent',
        created_at: '2026-02-09T00:20:00Z',
        actor: { login: 'bob' },
        repo: { id: 2002, name: 'proofwork/archive-repo-two' },
        payload: { ref_type: 'repository' },
      },
    ];

    const server = startStubGhArchiveServer({ hour, events });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const addr: any = server.address();
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const r1 = await runGithubIngestOnce({
      sourceId: 'gh_archive',
      sourceKind: 'gh_archive',
      baseUrl,
      archiveHour: hour,
      now: new Date('2026-02-09T01:00:00Z'),
    });
    expect(r1.fetched).toBe(2);
    expect(String((r1.cursor as any)?.nextHour ?? '')).toBe('2026-02-09-1');

    const c1 = await pool.query<{ c: string }>('SELECT count(*)::text as c FROM github_events_raw');
    expect(Number(c1.rows[0]?.c ?? 0)).toBe(2);

    const src1 = await pool.query<{ cursor_json: any }>("SELECT cursor_json FROM github_sources WHERE id='gh_archive'");
    expect(String(src1.rows[0]?.cursor_json?.nextHour ?? '')).toBe('2026-02-09-1');

    // Idempotent: ingest the same hour again should not create duplicate events.
    const r2 = await runGithubIngestOnce({
      sourceId: 'gh_archive',
      sourceKind: 'gh_archive',
      baseUrl,
      archiveHour: hour,
      now: new Date('2026-02-09T01:05:00Z'),
    });
    expect(r2.fetched).toBe(2);

    const c2 = await pool.query<{ c: string }>('SELECT count(*)::text as c FROM github_events_raw');
    expect(Number(c2.rows[0]?.c ?? 0)).toBe(2);

    const src2 = await pool.query<{ sources_json: any }>("SELECT sources_json FROM github_events_raw WHERE event_id='101'");
    const sources = Array.isArray(src2.rows[0]?.sources_json) ? src2.rows[0]?.sources_json : [];
    expect(sources.includes('gh_archive')).toBe(true);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

