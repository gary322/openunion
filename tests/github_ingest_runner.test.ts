import { describe, it, expect, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { pool } from '../src/db/client.js';
import { resetStore } from '../src/store.js';
import { runGithubIngestOnce } from '../workers/github-ingest-runner.js';

function startStubGitHubServer(events: any[]) {
  const server = createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/events') {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(events));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  return server;
}

describe('github ingest runner (events_api)', () => {
  beforeEach(async () => {
    await resetStore();
    // Ensure intel tables are empty even if a prior test created rows.
    await pool.query('TRUNCATE TABLE github_events_raw, github_repos, github_sources, intel_similarity_results, intel_similarity_queries, intel_provenance_manifests');
  });

  it('ingests events idempotently and updates cursor', async () => {
    const events = [
      {
        id: '1',
        type: 'PushEvent',
        created_at: '2026-02-09T00:00:00Z',
        actor: { login: 'alice' },
        repo: { id: 1001, name: 'proofwork/smoke-repo-one' },
        payload: { distinct_size: 1 },
      },
      {
        id: '2',
        type: 'WatchEvent',
        created_at: '2026-02-09T00:01:00Z',
        actor: { login: 'bob' },
        repo: { id: 1002, name: 'proofwork/smoke-repo-two' },
        payload: { action: 'started' },
      },
    ];

    const server = startStubGitHubServer(events);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const addr: any = server.address();
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const r1 = await runGithubIngestOnce({
      sourceId: 'events_api',
      sourceKind: 'events_api',
      baseUrl,
      maxEvents: 100,
      now: new Date('2026-02-09T00:02:00Z'),
    });
    expect(r1.fetched).toBe(2);

    const c1 = await pool.query<{ c: string }>('SELECT count(*)::text as c FROM github_events_raw');
    expect(Number(c1.rows[0]?.c ?? 0)).toBe(2);
    const repos1 = await pool.query<{ c: string }>('SELECT count(*)::text as c FROM github_repos');
    expect(Number(repos1.rows[0]?.c ?? 0)).toBe(2);

    const src1 = await pool.query<{ cursor_json: any; status: string }>("SELECT cursor_json, status FROM github_sources WHERE id='events_api'");
    expect(src1.rows[0]?.status).toBe('active');
    expect(String(src1.rows[0]?.cursor_json?.lastEventId ?? '')).toBe('2');

    // Second run with the same data should not create duplicate rows.
    const r2 = await runGithubIngestOnce({
      sourceId: 'events_api',
      sourceKind: 'events_api',
      baseUrl,
      maxEvents: 100,
      now: new Date('2026-02-09T00:03:00Z'),
    });
    expect(r2.fetched).toBe(2);

    const c2 = await pool.query<{ c: string }>('SELECT count(*)::text as c FROM github_events_raw');
    expect(Number(c2.rows[0]?.c ?? 0)).toBe(2);
    const repos2 = await pool.query<{ c: string }>('SELECT count(*)::text as c FROM github_repos');
    expect(Number(repos2.rows[0]?.c ?? 0)).toBe(2);

    const src2 = await pool.query<{ cursor_json: any; status: string }>("SELECT cursor_json, status FROM github_sources WHERE id='events_api'");
    expect(src2.rows[0]?.status).toBe('active');
    expect(String(src2.rows[0]?.cursor_json?.lastEventId ?? '')).toBe('2');
    expect(String(src2.rows[0]?.cursor_json?.lastPollAt ?? '')).toContain('2026-02-09T00:03:00.000Z');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

