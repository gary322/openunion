import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildServer } from '../src/server.js';
import { pool } from '../src/db/client.js';
import { resetStore, getJob, getSubmission } from '../src/store.js';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

function runNodeScript(params: { scriptPath: string; env: Record<string, string | undefined>; cwd: string }) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [params.scriptPath], {
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

describe('OpenClaw Proofwork Universal Worker integration', () => {
  const verifierToken = 'pw_vf_internal';
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

  async function makeMockOpenClawBin(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mock-openclaw-'));
    const bin = join(dir, 'openclaw');
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const script = `#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

async function main() {
  if (args[0] === "browser" && args[1] === "open") {
    out({ url: args[2] ?? "", targetId: "t_mock_1" });
    return;
  }
  if (args[0] === "browser" && args[1] === "navigate") {
    out({ ok: true });
    return;
  }
  if (args[0] === "browser" && args[1] === "wait") {
    out({ ok: true });
    return;
  }
  if (args[0] === "browser" && args[1] === "press") {
    out({ ok: true });
    return;
  }
  if (args[0] === "browser" && args[1] === "snapshot") {
    // Write a tiny role snapshot to the --out path so the worker can resolve refs.
    const outIdx = args.indexOf("--out");
    const outPath = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : path.join(os.tmpdir(), "mock_snapshot.txt");
    const snapshot = [
      '- button "Continue" [ref=e1]',
      '- textbox "Email" [ref=e2]',
    ].join("\\n") + "\\n";
    await fs.writeFile(outPath, snapshot, "utf8");
    out({ out: outPath });
    return;
  }
  if (args[0] === "browser" && args[1] === "click") {
    out({ ok: true });
    return;
  }
  if (args[0] === "browser" && args[1] === "type") {
    out({ ok: true });
    return;
  }
  if (args[0] === "browser" && args[1] === "evaluate") {
    out({ result: "ok" });
    return;
  }
  if (args[0] === "browser" && args[1] === "screenshot") {
    const outPath = path.join(os.tmpdir(), "mock_openclaw_" + Date.now() + "_" + Math.random().toString(16).slice(2) + ".png");
    const bytes = Buffer.from([${Array.from(pngBytes).join(',')}]);
    await fs.writeFile(outPath, bytes);
    out({ path: outPath });
    return;
  }
  if (args[0] === "browser" && args[1] === "close") {
    return;
  }
  // Default: succeed with no output.
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
`;
    await writeFile(bin, script, 'utf8');
    await chmod(bin, 0o755);
    return bin;
  }

  async function makeMockLlmBin(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mock-llm-'));
    const bin = join(dir, 'llm');
    const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "arxiv-search") {
  // Simulate llm-arxiv output including an OSC 52 clipboard sequence on stdout.
  process.stdout.write("\\u001b]52;c;Y29weS1jb21tYW5kcw==\\u0007");
  process.stdout.write("Found 2 result(s) for 'test':\\n\\n");
  process.stdout.write("[1] ID: 2310.06825\\n");
  process.stdout.write("    Title: Test Paper One\\n");
  process.stdout.write("    Command: $ llm arxiv 2310.06825\\n");
  process.stdout.write("---\\n");
  process.stdout.write("[2] ID: 2401.00001\\n");
  process.stdout.write("    Title: Test Paper Two\\n");
  process.stdout.write("    Command: $ llm arxiv 2401.00001\\n");
  process.stdout.write("---\\n");
  process.exit(0);
}
process.exit(0);
`;
    await writeFile(bin, script, 'utf8');
    await chmod(bin, 0o755);
    return bin;
  }

  it('claims + uploads + submits using the OpenClaw worker script (stubbed openclaw)', async () => {
    // Register a worker token the script will use.
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { openclaw: true } });
    expect(reg.status).toBe(200);
    const workerToken = reg.body.token as string;

    // Find the demo job and attach a descriptor that requires screenshot + report.
    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${workerToken}`);
    expect(next.status).toBe(200);
    expect(next.body.state).toBe('claimable');
    const job = next.body.data.job;
    // Seed data creates multiple jobs (one per fingerprint class). Make the test deterministic by leaving exactly one job.
    await pool.query('DELETE FROM jobs WHERE id <> $1', [job.jobId]);

    const descriptor = {
      schema_version: 'v1',
      type: 'openclaw_universal_worker_test',
      capability_tags: ['screenshot', 'llm_summarize'],
      input_spec: { url: 'https://example.com' },
      output_spec: {
        required_artifacts: [
          { kind: 'screenshot', count: 1 },
          { kind: 'other', count: 1, label_prefix: 'references' },
        ],
      },
    };
    await pool.query('UPDATE jobs SET task_descriptor=$1 WHERE id=$2', [JSON.stringify(descriptor), job.jobId]);

    const mockOpenClaw = await makeMockOpenClawBin();
    const scriptPath = 'integrations/openclaw/skills/proofwork-universal-worker/scripts/proofwork_worker.mjs';
    const run = await runNodeScript({
      scriptPath,
      cwd: process.cwd(),
      env: {
        ONCE: 'true',
        PROOFWORK_API_BASE_URL: baseUrl,
        PROOFWORK_WORKER_TOKEN: workerToken,
        PROOFWORK_SUPPORTED_CAPABILITY_TAGS: 'browser,http,screenshot,llm_summarize',
        PROOFWORK_CANARY_PERCENT: '100',
        OPENCLAW_BIN: mockOpenClaw,
        // Do not use OpenClaw LLM in tests; force deterministic fallback.
        OPENCLAW_AGENT_ID: '',
      },
    });
    if (run.code !== 0) {
      // Help debug by surfacing subprocess output in CI logs.
      // eslint-disable-next-line no-console
      console.log('openclaw worker stdout:\n', run.stdout);
      // eslint-disable-next-line no-console
      console.log('openclaw worker stderr:\n', run.stderr);
    }
    expect(run.code).toBe(0);

    const updated = await getJob(job.jobId);
    expect(updated?.status).toBe('verifying');
    expect(updated?.currentSubmissionId).toBeTruthy();

    const submissionId = String(updated?.currentSubmissionId ?? '');
    const sub = await getSubmission(submissionId);
    expect(sub).toBeTruthy();
    const labels = new Set((sub?.artifactIndex ?? []).map((a: any) => String(a.label)));
    expect(labels.has('openclaw_screenshot')).toBe(true);
    expect(labels.has('report_summary')).toBe(true);
    expect(labels.has('references_main')).toBe(true);

    // Validate the structured JSON artifact content matches the verifier expectations.
    const refArt = (sub?.artifactIndex ?? []).find((a: any) => String(a.label) === 'references_main');
    expect(refArt).toBeTruthy();
    const refUrl = String((refArt as any)?.url ?? '');
    const m = refUrl.match(/\/api\/artifacts\/([^/]+)\/download/);
    expect(m?.[1]).toBeTruthy();

    const dl = await request(app.server)
      .get(`/api/artifacts/${m?.[1]}/download`)
      .set('Authorization', `Bearer ${workerToken}`);
    expect(dl.status).toBe(200);
    const parsed = JSON.parse(String(dl.text ?? dl.body ?? ''));
    expect(Array.isArray(parsed?.references)).toBe(true);
    expect(parsed.references.length).toBeGreaterThan(0);
    expect(parsed.references[0].id).toBeTruthy();
    expect(String(parsed.references[0].url ?? '')).toContain('arxiv.org');

    // Finish verification to complete the job.
    const claimVer = await request(app.server)
      .post('/api/verifier/claim')
      .set('Authorization', `Bearer ${verifierToken}`)
      .send({
        submissionId,
        attemptNo: 1,
        messageId: 'msg1',
        idempotencyKey: 'idem1',
        verifierInstanceId: 'verifier-1',
        claimTtlSec: 600,
      });
    expect(claimVer.status).toBe(200);

    const verificationId = claimVer.body.verificationId;
    const claimToken = claimVer.body.claimToken;

    const verdict = await request(app.server)
      .post('/api/verifier/verdict')
      .set('Authorization', `Bearer ${verifierToken}`)
      .send({
        verificationId,
        claimToken,
        submissionId,
        jobId: job.jobId,
        attemptNo: 1,
        verdict: 'pass',
        reason: 'ok',
        scorecard: { R: 1, E: 1, A: 1, N: 1, T: 1, qualityScore: 100 },
        evidenceArtifacts: sub?.artifactIndex ?? [],
      });
    expect(verdict.status).toBe(200);

    const done = await request(app.server).get(`/api/jobs/${job.jobId}`).set('Authorization', `Bearer ${workerToken}`);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('done');
    expect(done.body.finalVerdict).toBe('pass');
  });

  it('uses llm-arxiv search output for arxiv tasks when enabled (stubbed llm)', async () => {
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { openclaw: true } });
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
      type: 'arxiv_research_plan',
      capability_tags: ['http', 'llm_summarize'],
      input_spec: { idea: 'test' },
      output_spec: {
        required_artifacts: [
          { kind: 'other', count: 1, label_prefix: 'references' },
          { kind: 'log', count: 1, label_prefix: 'report' },
        ],
      },
      freshness_sla_sec: 86400,
    };
    await pool.query('UPDATE jobs SET task_descriptor=$1 WHERE id=$2', [JSON.stringify(descriptor), job.jobId]);

    const mockOpenClaw = await makeMockOpenClawBin();
    const mockLlm = await makeMockLlmBin();
    const scriptPath = 'integrations/openclaw/skills/proofwork-universal-worker/scripts/proofwork_worker.mjs';
    const run = await runNodeScript({
      scriptPath,
      cwd: process.cwd(),
      env: {
        ONCE: 'true',
        PROOFWORK_API_BASE_URL: baseUrl,
        PROOFWORK_WORKER_TOKEN: workerToken,
        PROOFWORK_SUPPORTED_CAPABILITY_TAGS: 'browser,http,screenshot,llm_summarize',
        PROOFWORK_CANARY_PERCENT: '100',
        OPENCLAW_BIN: mockOpenClaw,
        OPENCLAW_AGENT_ID: '',
        LLM_ARXIV_ENABLED: 'true',
        LLM_ARXIV_MAX_RESULTS: '2',
        LLM_BIN: mockLlm,
      },
    });
    if (run.code !== 0) {
      // eslint-disable-next-line no-console
      console.log('openclaw worker stdout:\n', run.stdout);
      // eslint-disable-next-line no-console
      console.log('openclaw worker stderr:\n', run.stderr);
    }
    expect(run.code).toBe(0);

    const updated = await getJob(job.jobId);
    expect(updated?.status).toBe('verifying');
    expect(updated?.currentSubmissionId).toBeTruthy();

    const submissionId = String(updated?.currentSubmissionId ?? '');
    const sub = await getSubmission(submissionId);
    expect(sub).toBeTruthy();

    const refArt = (sub?.artifactIndex ?? []).find((a: any) => String(a.label) === 'references_main');
    expect(refArt).toBeTruthy();
    const refUrl = String((refArt as any)?.url ?? '');
    const m = refUrl.match(/\/api\/artifacts\/([^/]+)\/download/);
    expect(m?.[1]).toBeTruthy();

    const dl = await request(app.server)
      .get(`/api/artifacts/${m?.[1]}/download`)
      .set('Authorization', `Bearer ${workerToken}`);
    expect(dl.status).toBe(200);
    const parsed = JSON.parse(String(dl.text ?? dl.body ?? ''));
    const ids = new Set((parsed?.references ?? []).map((r: any) => String(r?.id ?? '')));
    expect(ids.has('arxiv:2310.06825')).toBe(true);
    expect(ids.has('arxiv:2401.00001')).toBe(true);

    // Finish verification to complete the job.
    const claimVer = await request(app.server)
      .post('/api/verifier/claim')
      .set('Authorization', `Bearer ${verifierToken}`)
      .send({
        submissionId,
        attemptNo: 1,
        messageId: 'msg1',
        idempotencyKey: 'idem1',
        verifierInstanceId: 'verifier-1',
        claimTtlSec: 600,
      });
    expect(claimVer.status).toBe(200);

    const verificationId = claimVer.body.verificationId;
    const claimToken = claimVer.body.claimToken;

    const verdict = await request(app.server)
      .post('/api/verifier/verdict')
      .set('Authorization', `Bearer ${verifierToken}`)
      .send({
        verificationId,
        claimToken,
        submissionId,
        jobId: job.jobId,
        attemptNo: 1,
        verdict: 'pass',
        reason: 'ok',
        scorecard: { R: 1, E: 1, A: 1, N: 1, T: 1, qualityScore: 100 },
        evidenceArtifacts: sub?.artifactIndex ?? [],
      });
    expect(verdict.status).toBe(200);

    const done = await request(app.server).get(`/api/jobs/${job.jobId}`).set('Authorization', `Bearer ${workerToken}`);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('done');
    expect(done.body.finalVerdict).toBe('pass');
  });

  it('does not claim jobs that require unsupported capability tags', async () => {
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { openclaw: true } });
    const workerToken = reg.body.token as string;

    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${workerToken}`);
    expect(next.status).toBe(200);
    const job = next.body.data.job;
    // Seed data creates multiple jobs (one per fingerprint class). Make the test deterministic by leaving exactly one job.
    await pool.query('DELETE FROM jobs WHERE id <> $1', [job.jobId]);

    const descriptor = {
      schema_version: 'v1',
      type: 'ffmpeg_only_test',
      capability_tags: ['ffmpeg'],
      input_spec: { vod_url: 'https://example.com/video.mp4', start_sec: 0, duration_sec: 1 },
      output_spec: { required_artifacts: [{ kind: 'video', count: 1 }] },
      freshness_sla_sec: 3600,
    };
    await pool.query('UPDATE jobs SET task_descriptor=$1 WHERE id=$2', [JSON.stringify(descriptor), job.jobId]);

    const mockOpenClaw = await makeMockOpenClawBin();
    const scriptPath = 'integrations/openclaw/skills/proofwork-universal-worker/scripts/proofwork_worker.mjs';
    const run = await runNodeScript({
      scriptPath,
      cwd: process.cwd(),
      env: {
        ONCE: 'true',
        PROOFWORK_API_BASE_URL: baseUrl,
        PROOFWORK_WORKER_TOKEN: workerToken,
        PROOFWORK_SUPPORTED_CAPABILITY_TAGS: 'browser,http,screenshot,llm_summarize', // no ffmpeg
        PROOFWORK_CANARY_PERCENT: '100',
        OPENCLAW_BIN: mockOpenClaw,
      },
    });
    expect(run.code).toBe(0);

    const row = await getJob(job.jobId);
    expect(row?.status).toBe('open');
    expect(row?.leaseWorkerId).toBeUndefined();
  });

  it('executes site_profile.browser_flow steps via OpenClaw browser actions', async () => {
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { openclaw: true } });
    const workerToken = reg.body.token as string;

    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${workerToken}`);
    expect(next.status).toBe(200);
    const job = next.body.data.job;
    // Seed data creates multiple jobs (one per fingerprint class). Make the test deterministic by leaving exactly one job.
    await pool.query('DELETE FROM jobs WHERE id <> $1', [job.jobId]);

    const descriptor = {
      schema_version: 'v1',
      type: 'openclaw_browser_flow_test',
      capability_tags: ['browser', 'screenshot', 'llm_summarize'],
      input_spec: { url: 'https://example.com' },
      site_profile: {
        browser_flow: {
          steps: [
            { op: 'fill', role: 'textbox', name: 'Email', value: 'hello' },
            { op: 'click', role: 'button', name: 'Continue' },
            { op: 'wait', ms: 50 },
            { op: 'screenshot', label: 'after_flow', full_page: true },
          ],
        },
      },
      output_spec: { required_artifacts: [{ kind: 'screenshot', count: 1 }, { kind: 'log', count: 1, label_prefix: 'report' }] },
      freshness_sla_sec: 3600,
    };
    await pool.query('UPDATE jobs SET task_descriptor=$1 WHERE id=$2', [JSON.stringify(descriptor), job.jobId]);

    const mockOpenClaw = await makeMockOpenClawBin();
    const scriptPath = 'integrations/openclaw/skills/proofwork-universal-worker/scripts/proofwork_worker.mjs';
    const run = await runNodeScript({
      scriptPath,
      cwd: process.cwd(),
      env: {
        ONCE: 'true',
        PROOFWORK_API_BASE_URL: baseUrl,
        PROOFWORK_WORKER_TOKEN: workerToken,
        PROOFWORK_SUPPORTED_CAPABILITY_TAGS: 'browser,http,screenshot,llm_summarize',
        PROOFWORK_CANARY_PERCENT: '100',
        OPENCLAW_BIN: mockOpenClaw,
        OPENCLAW_AGENT_ID: '',
      },
    });
    if (run.code !== 0) {
      // eslint-disable-next-line no-console
      console.log('openclaw worker stdout:\n', run.stdout);
      // eslint-disable-next-line no-console
      console.log('openclaw worker stderr:\n', run.stderr);
    }
    expect(run.code).toBe(0);

    const updated = await getJob(job.jobId);
    expect(updated?.status).toBe('verifying');
    expect(updated?.currentSubmissionId).toBeTruthy();

    const submissionId = String(updated?.currentSubmissionId ?? '');
    const sub = await getSubmission(submissionId);
    const labels = new Set((sub?.artifactIndex ?? []).map((a: any) => String(a.label)));
    expect(labels.has('universal_screenshot')).toBe(true);
    expect(labels.has('browser_flow')).toBe(true);
    expect(labels.has('after_flow')).toBe(true);
    expect(labels.has('report_summary')).toBe(true);
  });
});
