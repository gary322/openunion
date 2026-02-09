import { describe, it, expect, beforeEach } from 'vitest';
import { buildServer } from '../src/server.js';
import request from 'supertest';
import { resetStore } from '../src/store.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

function startStubGitHubServer(items: any[]) {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname === '/search/repositories') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ total_count: items.length, incomplete_results: false, items }));
      return;
    }
    if (u.pathname === '/events') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify([]));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  return server;
}

function runNodeScript(params: { scriptPath: string; args?: string[]; env: Record<string, string | undefined>; cwd: string }) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [params.scriptPath, ...(params.args ?? [])], {
      cwd: params.cwd,
      env: { ...process.env, ...params.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('Codex skill contract (github-intelligence)', () => {
  beforeEach(async () => {
    await resetStore();
  });

  it('runs similar + reuse-plan + policy-explain against a live server', async () => {
    const oldGhBase = process.env.GITHUB_API_BASE_URL;
    try {
      const items = [
        {
          id: 3001,
          full_name: 'example/vector-db',
          html_url: 'https://github.com/example/vector-db',
          stargazers_count: 123,
          forks_count: 10,
          archived: false,
          description: 'vector database',
          license: { spdx_id: 'MIT', key: 'mit' },
          topics: ['vector', 'database'],
        },
      ];
      const gh = startStubGitHubServer(items);
      gh.listen(0, '127.0.0.1');
      await once(gh, 'listening');
      const ghAddr: any = gh.address();
      const ghBaseUrl = `http://127.0.0.1:${ghAddr.port}`;
      process.env.GITHUB_API_BASE_URL = ghBaseUrl;

      const app = buildServer();
      await app.ready();
      await app.listen({ port: 0, host: '127.0.0.1' });
      const addr = app.server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        const email = `skill+${Date.now()}@example.com`;
        const password = 'password123';
        const reg = await request(app.server).post('/api/org/register').send({ orgName: 'Skill Org', email, password, apiKeyName: 'default' });
        expect(reg.status).toBe(200);
        const buyerToken = String(reg.body.token ?? '');
        expect(buyerToken.startsWith('pw_bu_')).toBeTruthy();

        const env = {
          PROOFWORK_API_BASE_URL: baseUrl,
          PROOFWORK_BUYER_TOKEN: buyerToken,
        };

        const similar = await runNodeScript({
          scriptPath: 'skills/codex/github-intelligence/scripts/similar.mjs',
          args: ['vector database'],
          cwd: process.cwd(),
          env,
        });
        expect(similar.code).toBe(0);
        const similarJson = JSON.parse(similar.stdout);
        expect(similarJson.ok).toBe(true);
        expect(typeof similarJson.queryId).toBe('string');

        const explain1 = await runNodeScript({
          scriptPath: 'skills/codex/github-intelligence/scripts/policy-explain.mjs',
          args: [String(similarJson.queryId)],
          cwd: process.cwd(),
          env,
        });
        expect(explain1.code).toBe(0);
        const explainJson1 = JSON.parse(explain1.stdout);
        expect(explainJson1.ok).toBe(true);
        expect(Array.isArray(explainJson1.manifests)).toBe(true);
        expect(explainJson1.manifests.length).toBeGreaterThan(0);

        const plan = await runNodeScript({
          scriptPath: 'skills/codex/github-intelligence/scripts/reuse-plan.mjs',
          args: ['vector database'],
          cwd: process.cwd(),
          env,
        });
        expect(plan.code).toBe(0);
        const planJson = JSON.parse(plan.stdout);
        expect(planJson.ok).toBe(true);
        expect(typeof planJson.planId).toBe('string');
        expect(Array.isArray(planJson.plan?.steps)).toBe(true);

        const explain2 = await runNodeScript({
          scriptPath: 'skills/codex/github-intelligence/scripts/policy-explain.mjs',
          args: [String(planJson.planId)],
          cwd: process.cwd(),
          env,
        });
        expect(explain2.code).toBe(0);
        const explainJson2 = JSON.parse(explain2.stdout);
        expect(explainJson2.ok).toBe(true);
        expect(Array.isArray(explainJson2.manifests)).toBe(true);
        expect(explainJson2.manifests.length).toBeGreaterThan(0);
      } finally {
        await app.close();
        await new Promise<void>((resolve) => gh.close(() => resolve()));
      }
    } finally {
      process.env.GITHUB_API_BASE_URL = oldGhBase;
    }
  });
});

