import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildServer } from '../src/server.js';
import { pool } from '../src/db/client.js';
import { resetStore, getJob } from '../src/store.js';
import { spawn } from 'node:child_process';

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

describe('Universal Worker require_job_id', () => {
  let app: any;
  let baseUrl = '';

  beforeEach(async () => {
    await resetStore();
    app = buildServer();
    await app.ready();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  it('claims only the requested job id', async () => {
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { http: true } });
    expect(reg.status).toBe(200);
    const workerToken = reg.body.token as string;

    const jobs = await pool.query<{ id: string }>('SELECT id FROM jobs ORDER BY id LIMIT 2');
    expect(jobs.rows.length).toBe(2);
    const [jobA, jobB] = jobs.rows.map((r) => r.id);

    const descriptor = {
      schema_version: 'v1',
      type: 'require_job_test',
      capability_tags: ['http', 'llm_summarize'],
      input_spec: { url: `${baseUrl}/health` },
      output_spec: { http_response: true, required_artifacts: [{ kind: 'log', label: 'report_summary' }] },
      freshness_sla_sec: 3600,
    };
    await pool.query('UPDATE jobs SET task_descriptor=$1 WHERE id = ANY($2)', [JSON.stringify(descriptor), [jobA, jobB]]);

    const tsxBin = process.platform === 'win32' ? 'node_modules/.bin/tsx.cmd' : 'node_modules/.bin/tsx';
    const run = await runCommand({
      cmd: tsxBin,
      args: ['skills/universal-worker/worker.ts'],
      cwd: process.cwd(),
      timeoutMs: 120_000,
      env: {
        ONCE: 'true',
        API_BASE_URL: baseUrl,
        WORKER_TOKEN: workerToken,
        SUPPORTED_CAPABILITY_TAGS: 'http,llm_summarize',
        UNIVERSAL_WORKER_CANARY_PERCENT: '100',
        REQUIRE_JOB_ID: jobB,
      },
    });
    if (run.code !== 0) {
      // eslint-disable-next-line no-console
      console.log('universal worker stdout:\n', run.stdout);
      // eslint-disable-next-line no-console
      console.log('universal worker stderr:\n', run.stderr);
    }
    expect(run.code).toBe(0);

    const a = await getJob(jobA);
    const b = await getJob(jobB);
    expect(b?.status).toBe('verifying');
    expect(a?.status).not.toBe('verifying');
  });
});

