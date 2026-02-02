import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildServer } from '../src/server.js';
import { pool } from '../src/db/client.js';
import { resetStore, getJob, getSubmission } from '../src/store.js';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

function runCommand(params: { cmd: string; args: string[]; env: Record<string, string | undefined>; cwd: string; timeoutMs?: number }) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(params.cmd, params.args, {
      cwd: params.cwd,
      env: { ...process.env, ...params.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));

    const t = setTimeout(() => {
      child.kill('SIGKILL');
    }, params.timeoutMs ?? 120_000);
    t.unref?.();

    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('Universal Worker browser_flow (Playwright) integration', () => {
  let app: any;
  let baseUrl = '';
  let siteUrl = '';
  let siteServer: any;

  beforeEach(async () => {
    await resetStore();

    // Start Proofwork API on an ephemeral port so the worker can call it via fetch().
    app = buildServer();
    await app.ready();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    // Start a tiny local website fixture for browser flow actions.
    siteServer = createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body>
    <div id="status">Ready</div>
    <label>Query <input id="q" aria-label="Query" /></label>
    <button id="go">Go</button>
    <script>
      document.getElementById('go').addEventListener('click', () => {
        document.getElementById('status').textContent = 'Done';
      });
    </script>
  </body>
</html>`);
    });
    siteServer.listen(0, '127.0.0.1');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await once(siteServer, 'listening');
    const siteAddr: any = siteServer.address();
    siteUrl = `http://127.0.0.1:${siteAddr.port}/`;
  });

  afterEach(async () => {
    await app.close();
    await new Promise<void>((resolve) => siteServer.close(() => resolve()));
  });

  it('executes a site_profile.browser_flow and still submits with universal_screenshot', async () => {
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { browser: true } });
    expect(reg.status).toBe(200);
    const workerToken = reg.body.token as string;

    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${workerToken}`);
    expect(next.status).toBe(200);
    expect(next.body.state).toBe('claimable');
    const job = next.body.data.job;
    // Seed data creates multiple jobs (one per fingerprint class). Make the test deterministic by leaving exactly one job.
    await pool.query('DELETE FROM jobs WHERE id <> $1', [job.jobId]);

    const descriptor = {
      schema_version: 'v1',
      type: 'browser_flow_test',
      capability_tags: ['browser', 'screenshot', 'llm_summarize'],
      input_spec: { url: siteUrl },
      site_profile: {
        browser_flow: {
          steps: [
            { op: 'fill', selector: '#q', value: 'hello' },
            { op: 'click', selector: '#go' },
            { op: 'wait', text: 'Done', timeout_ms: 5000 },
            { op: 'extract', key: 'status_text', selector: '#status', kind: 'text' },
            { op: 'screenshot', label: 'after_go', full_page: true },
          ],
        },
      },
      output_spec: { required_artifacts: [{ kind: 'screenshot', count: 1 }, { kind: 'log', count: 1, label_prefix: 'report' }] },
      freshness_sla_sec: 3600,
    };
    await pool.query('UPDATE jobs SET task_descriptor=$1 WHERE id=$2', [JSON.stringify(descriptor), job.jobId]);

    const tsxBin = process.platform === 'win32' ? 'node_modules/.bin/tsx.cmd' : 'node_modules/.bin/tsx';
    const run = await runCommand({
      cmd: tsxBin,
      args: ['skills/universal-worker/worker.ts'],
      cwd: process.cwd(),
      timeoutMs: 180_000,
      env: {
        ONCE: 'true',
        API_BASE_URL: baseUrl,
        WORKER_TOKEN: workerToken,
        SUPPORTED_CAPABILITY_TAGS: 'browser,http,screenshot,llm_summarize',
        UNIVERSAL_WORKER_CANARY_PERCENT: '100',
      },
    });
    if (run.code !== 0) {
      // eslint-disable-next-line no-console
      console.log('universal worker stdout:\n', run.stdout);
      // eslint-disable-next-line no-console
      console.log('universal worker stderr:\n', run.stderr);
    }
    expect(run.code).toBe(0);

    const updated = await getJob(job.jobId);
    expect(updated?.status).toBe('verifying');
    expect(updated?.currentSubmissionId).toBeTruthy();

    const submissionId = String(updated?.currentSubmissionId ?? '');
    const sub = await getSubmission(submissionId);
    expect(sub).toBeTruthy();

    const labels = new Set((sub?.artifactIndex ?? []).map((a: any) => String(a.label)));
    expect(labels.has('universal_screenshot')).toBe(true);
    expect(labels.has('browser_flow')).toBe(true);
    expect(labels.has('report_summary')).toBe(true);
    // The flow also emitted an extra screenshot.
    expect(labels.has('after_go')).toBe(true);
  });
});
