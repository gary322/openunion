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

function stripIds(obj: any) {
  const clone = JSON.parse(JSON.stringify(obj));
  delete clone.queryId;
  delete clone.planId;
  return clone;
}

describe('skill parity: Codex vs Claude github-intelligence', () => {
  beforeEach(async () => {
    await resetStore();
  });

  it('returns the same results for similar and reuse-plan (excluding ids)', async () => {
    const oldGhBase = process.env.GITHUB_API_BASE_URL;
    try {
      const items = [
        {
          id: 5001,
          full_name: 'example/vector-db',
          html_url: 'https://github.com/example/vector-db',
          stargazers_count: 123,
          forks_count: 10,
          archived: false,
          description: 'vector database',
          license: { spdx_id: 'MIT', key: 'mit' },
          topics: ['vector', 'database'],
        },
        {
          id: 5002,
          full_name: 'example/other-db',
          html_url: 'https://github.com/example/other-db',
          stargazers_count: 10,
          forks_count: 1,
          archived: false,
          description: 'db',
          license: { spdx_id: 'Apache-2.0', key: 'apache-2.0' },
          topics: ['database'],
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

        const env = {
          PROOFWORK_API_BASE_URL: baseUrl,
          PROOFWORK_BUYER_TOKEN: buyerToken,
        };

        const codexSimilar = await runNodeScript({
          scriptPath: 'skills/codex/github-intelligence/scripts/similar.mjs',
          args: ['vector database'],
          cwd: process.cwd(),
          env,
        });
        const claudeSimilar = await runNodeScript({
          scriptPath: 'integrations/claude/skills/github-intelligence/scripts/similar.mjs',
          args: ['vector database'],
          cwd: process.cwd(),
          env,
        });
        expect(codexSimilar.code).toBe(0);
        expect(claudeSimilar.code).toBe(0);
        const a = stripIds(JSON.parse(codexSimilar.stdout));
        const b = stripIds(JSON.parse(claudeSimilar.stdout));
        expect(a.ok).toBe(true);
        expect(b.ok).toBe(true);
        expect(a.results).toEqual(b.results);
        expect(a.blocked).toEqual(b.blocked);

        const codexPlan = await runNodeScript({
          scriptPath: 'skills/codex/github-intelligence/scripts/reuse-plan.mjs',
          args: ['vector database'],
          cwd: process.cwd(),
          env,
        });
        const claudePlan = await runNodeScript({
          scriptPath: 'integrations/claude/skills/github-intelligence/scripts/reuse-plan.mjs',
          args: ['vector database'],
          cwd: process.cwd(),
          env,
        });
        expect(codexPlan.code).toBe(0);
        expect(claudePlan.code).toBe(0);
        const pa = stripIds(JSON.parse(codexPlan.stdout));
        const pb = stripIds(JSON.parse(claudePlan.stdout));
        expect(pa.ok).toBe(true);
        expect(pb.ok).toBe(true);
        expect(pa.candidates).toEqual(pb.candidates);
        expect(pa.plan).toEqual(pb.plan);
        expect(pa.blocked).toEqual(pb.blocked);
      } finally {
        await app.close();
        await new Promise<void>((resolve) => gh.close(() => resolve()));
      }
    } finally {
      process.env.GITHUB_API_BASE_URL = oldGhBase;
    }
  });
});

