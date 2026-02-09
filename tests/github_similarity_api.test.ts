import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { buildServer } from '../src/server.js';
import { pool } from '../src/db/client.js';
import { resetStore } from '../src/store.js';

function startStubGitHubServer(items: any[]) {
  const server = createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/search/repositories') {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ total_count: items.length, incomplete_results: false, items }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  return server;
}

describe('/api/intel/similar', () => {
  beforeEach(async () => {
    await resetStore();
    await pool.query('TRUNCATE TABLE github_events_raw, github_repos, github_sources, intel_similarity_results, intel_similarity_queries, intel_provenance_manifests');
  });

  it('returns ranked repos and persists query/results', async () => {
    const oldGithubBase = process.env.GITHUB_API_BASE_URL;
    const oldGithubToken = process.env.GITHUB_TOKEN;
    const oldDeny = process.env.INTEL_LICENSE_DENYLIST;
    try {
      process.env.GITHUB_TOKEN = '';
      process.env.INTEL_LICENSE_DENYLIST = 'GPL-3.0';

      const items = [
        {
          id: 1001,
          full_name: 'proofwork/smoke-repo-one',
          html_url: 'https://github.com/proofwork/smoke-repo-one',
          description: 'Deterministic smoke repository entry.',
          stargazers_count: 12,
          forks_count: 1,
          archived: false,
          language: 'TypeScript',
          topics: ['proofwork', 'smoke'],
          license: { spdx_id: 'MIT', key: 'mit' },
        },
        {
          id: 1002,
          full_name: 'acme/smoke-repo-two',
          html_url: 'https://github.com/acme/smoke-repo-two',
          description: 'Second deterministic smoke repository entry.',
          stargazers_count: 123,
          forks_count: 10,
          archived: false,
          language: 'TypeScript',
          topics: ['smoke'],
          license: { spdx_id: 'Apache-2.0', key: 'apache-2.0' },
        },
        {
          id: 1003,
          full_name: 'proofwork/smoke-repo-gpl',
          html_url: 'https://github.com/proofwork/smoke-repo-gpl',
          description: 'Denied license',
          stargazers_count: 5000,
          forks_count: 500,
          archived: false,
          language: 'Go',
          topics: ['proofwork', 'smoke'],
          license: { spdx_id: 'GPL-3.0', key: 'gpl-3.0' },
        },
        {
          id: 1004,
          full_name: 'proofwork/smoke-repo-archived',
          html_url: 'https://github.com/proofwork/smoke-repo-archived',
          description: 'Archived repo should be blocked',
          stargazers_count: 9999,
          forks_count: 1,
          archived: true,
          language: 'Rust',
          topics: ['proofwork', 'smoke'],
          license: { spdx_id: 'MIT', key: 'mit' },
        },
      ];

      const gh = startStubGitHubServer(items);
      gh.listen(0, '127.0.0.1');
      await once(gh, 'listening');
      const ghAddr: any = gh.address();
      process.env.GITHUB_API_BASE_URL = `http://127.0.0.1:${ghAddr.port}`;

      const app = buildServer();
      await app.ready();
      try {
        const email = `intel+${Date.now()}@example.com`;
        const password = 'password123';
        const reg = await request(app.server).post('/api/org/register').send({ orgName: 'Intel Org', email, password, apiKeyName: 'default' });
        expect(reg.status).toBe(200);
        const buyerToken = String(reg.body.token ?? '');
        expect(buyerToken.startsWith('pw_bu_')).toBeTruthy();

        const resp = await request(app.server)
          .post('/api/intel/similar')
          .set('Authorization', `Bearer ${buyerToken}`)
          .send({ idea: 'proofwork smoke', constraints: { limit: 10 }, tool: 'vitest' });

        expect(resp.status).toBe(200);
        expect(resp.body.ok).toBe(true);
        expect(typeof resp.body.queryId).toBe('string');
        expect(typeof resp.body.policyVersion).toBe('string');
        expect(Array.isArray(resp.body.results)).toBe(true);
        expect(resp.body.results.length).toBe(2);
        expect(resp.body.results[0]?.fullName).toBe('proofwork/smoke-repo-one');
        expect(resp.body.results[1]?.fullName).toBe('acme/smoke-repo-two');
        expect(String(resp.body.results[0]?.explanation ?? '')).toContain('lexical=');

        expect(resp.body.blocked?.count).toBe(2);
        const blockedNames = (resp.body.blocked?.sample ?? []).map((x: any) => String(x.fullName));
        expect(blockedNames).toContain('proofwork/smoke-repo-gpl');
        expect(blockedNames).toContain('proofwork/smoke-repo-archived');

        const qCount = await pool.query<{ c: string }>('SELECT count(*)::text as c FROM intel_similarity_queries');
        expect(Number(qCount.rows[0]?.c ?? 0)).toBe(1);
        const rCount = await pool.query<{ c: string }>('SELECT count(*)::text as c FROM intel_similarity_results');
        expect(Number(rCount.rows[0]?.c ?? 0)).toBe(2);
        const pCount = await pool.query<{ c: string }>('SELECT count(*)::text as c FROM intel_provenance_manifests');
        expect(Number(pCount.rows[0]?.c ?? 0)).toBe(1);
        const repoCount = await pool.query<{ c: string }>('SELECT count(*)::text as c FROM github_repos');
        expect(Number(repoCount.rows[0]?.c ?? 0)).toBe(4);
      } finally {
        await app.close();
      }

      await new Promise<void>((resolve) => gh.close(() => resolve()));
    } finally {
      process.env.GITHUB_API_BASE_URL = oldGithubBase;
      process.env.GITHUB_TOKEN = oldGithubToken;
      process.env.INTEL_LICENSE_DENYLIST = oldDeny;
    }
  });
});
