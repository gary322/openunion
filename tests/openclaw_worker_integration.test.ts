import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildServer } from '../src/server.js';
import { pool } from '../src/db/client.js';
import { resetStore, getJob, getSubmission } from '../src/store.js';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

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
	    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x05, 0x05, 0x05, 0x05]);
	    const script = `#!/usr/bin/env node
	import fs from "node:fs/promises";
	import os from "node:os";
	import path from "node:path";

const argv = process.argv.slice(2);

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

async function readState(stateFile) {
  if (!stateFile) return { url: "" };
  try {
    const raw = await fs.readFile(stateFile, "utf8");
    const j = raw ? JSON.parse(raw) : null;
    return { url: typeof j?.url === "string" ? j.url : "" };
  } catch {
    return { url: "" };
  }
}

async function writeState(stateFile, patch) {
  if (!stateFile) return;
  const cur = await readState(stateFile);
  const next = { ...cur, ...(patch ?? {}) };
  await fs.writeFile(stateFile, JSON.stringify(next) + "\\n", "utf8");
}

function parseBrowserArgs(args) {
  let i = 1;
  let profile = null;
  while (i < args.length) {
    const a = args[i];
    if (a === "--browser-profile") {
      profile = args[i + 1] ?? null;
      i += 2;
      continue;
    }
    if (a === "--url" || a === "--token") {
      i += 2;
      continue;
    }
    break;
  }
  const cmd = args[i] ?? "";
  const rest = args.slice(i + 1);
  return { profile, cmd, rest };
}

async function main() {
  const logPath = process.env.MOCK_OPENCLAW_LOG;
  if (logPath) {
    try {
      await fs.appendFile(logPath, JSON.stringify({ argv }) + "\\n", "utf8");
    } catch {
      // ignore
    }
  }

  if (argv[0] !== "browser") return;
  const parsed = parseBrowserArgs(argv);
  const expectProfile = process.env.MOCK_OPENCLAW_EXPECT_PROFILE;
  if (expectProfile && parsed.profile !== expectProfile) {
    console.error("missing_or_wrong_browser_profile");
    process.exit(2);
  }

  const stateFile = process.env.MOCK_OPENCLAW_STATE_FILE;
  const cmd = parsed.cmd;
  const rest = parsed.rest;

  if (cmd === "create-profile") {
    out({ ok: true });
    return;
  }
  if (cmd === "start") {
    out({ ok: true });
    return;
  }
  if (cmd === "tab") {
    const sub = rest[0] ?? "";
    if (sub === "new") {
      await writeState(stateFile, { url: "about:blank" });
      out({ ok: true, tab: { targetId: "t_mock_tab_1", url: "about:blank" } });
      return;
    }
  }
  if (cmd === "open") {
    const url = rest[0] ?? "";
    await writeState(stateFile, { url });
    out({ url, targetId: "t_mock_1" });
    return;
  }
  if (cmd === "navigate") {
    const url = rest[0] ?? "";
    await writeState(stateFile, { url });
    out({ ok: true });
    return;
  }
  if (cmd === "wait") {
    out({ ok: true });
    return;
  }
  if (cmd === "press") {
    if (process.env.MOCK_OPENCLAW_AFTER_PRESS_URL) {
      await writeState(stateFile, { url: process.env.MOCK_OPENCLAW_AFTER_PRESS_URL });
    }
    out({ ok: true });
    return;
  }
  if (cmd === "snapshot") {
    if (String(process.env.MOCK_OPENCLAW_FAIL_SNAPSHOT ?? "").trim() === "1" || String(process.env.MOCK_OPENCLAW_FAIL_SNAPSHOT ?? "").trim().toLowerCase() === "true") {
      console.error("playwright_not_available");
      process.exit(1);
    }
    // Write a tiny role snapshot to the --out path so the worker can resolve refs.
    const outIdx = argv.indexOf("--out");
    const outPath = outIdx >= 0 && argv[outIdx + 1] ? argv[outIdx + 1] : path.join(os.tmpdir(), "mock_snapshot.txt");
    const snapshot = [
      '- button "Continue" [ref=e1]',
      '- textbox "Email" [ref=e2]',
    ].join("\\n") + "\\n";
    await fs.writeFile(outPath, snapshot, "utf8");
    out({ out: outPath });
    return;
  }
  if (cmd === "click") {
    if (process.env.MOCK_OPENCLAW_AFTER_CLICK_URL) {
      await writeState(stateFile, { url: process.env.MOCK_OPENCLAW_AFTER_CLICK_URL });
    }
    out({ ok: true });
    return;
  }
  if (cmd === "type") {
    out({ ok: true });
    return;
  }
  if (cmd === "evaluate") {
    const fnIdx = argv.indexOf("--fn");
    const fn = fnIdx >= 0 && argv[fnIdx + 1] ? String(argv[fnIdx + 1]) : "";
    // The worker uses location.href to enforce origin policies.
    if (fn.includes("location.href")) {
      const forced = process.env.MOCK_OPENCLAW_FORCE_LOCATION_HREF;
      const st = await readState(stateFile);
      out({ result: forced ?? st.url ?? (process.env.MOCK_OPENCLAW_FALLBACK_HREF ?? "https://example.com/") });
      return;
    }
    out({ result: "ok" });
    return;
	  }
	  if (cmd === "screenshot") {
	    // Match OpenClaw's screenshot CLI: no --target-id and no --out.
	    if (argv.includes("--target-id")) {
	      console.error("error: unknown option '--target-id'");
	      process.exit(1);
	    }
	    if (argv.includes("--out")) {
	      console.error("error: unknown option '--out'");
	      process.exit(1);
	    }
	    const outPath = path.join(os.tmpdir(), "mock_openclaw_" + Date.now() + "_" + Math.random().toString(16).slice(2) + ".jpg");
	    const bytes = Buffer.from([${Array.from(jpegBytes).join(',')}]);
	    await fs.writeFile(outPath, bytes);
	    out({ path: outPath });
	    return;
	  }
  if (cmd === "close") {
    return;
  }
  if (cmd === "reset-profile") {
    out({ ok: true });
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

    // Stub arXiv API for deterministic references without external network access.
    const arxivServer = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (u.pathname !== '/api/query') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/atom+xml; charset=utf-8');
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>arXiv Query</title>
  <entry>
    <id>http://arxiv.org/abs/2310.06825v1</id>
    <title>Test Paper One</title>
  </entry>
</feed>`);
    });
    arxivServer.listen(0, '127.0.0.1');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await once(arxivServer, 'listening');
    const arxivAddr: any = arxivServer.address();
    const arxivOrigin = `http://127.0.0.1:${arxivAddr.port}`;
    const arxivApiBaseUrl = `http://127.0.0.1:${arxivAddr.port}/api/query`;

    // Strict origin enforcement applies to worker-side HTTP fetches. Allow the stub arXiv origin
    // for this test job so the worker can fetch references without external network access.
    const b = await pool.query('SELECT allowed_origins FROM bounties WHERE id=$1', [job.bountyId]);
    const curAllowedRaw = b.rows?.[0]?.allowed_origins;
    const curAllowed: string[] = Array.isArray(curAllowedRaw)
      ? curAllowedRaw.map((o: any) => String(o))
      : typeof curAllowedRaw === 'string'
        ? (JSON.parse(curAllowedRaw) as any[]).map((o: any) => String(o))
        : [];
    const nextAllowed = Array.from(new Set([...curAllowed, arxivOrigin, 'https://arxiv.org']));
    await pool.query('UPDATE bounties SET allowed_origins=$1 WHERE id=$2', [JSON.stringify(nextAllowed), job.bountyId]);
    const orgRes = await pool.query('SELECT org_id FROM bounties WHERE id=$1', [job.bountyId]);
    const bountyOrgId = String(orgRes.rows?.[0]?.org_id ?? 'org_demo');
    await pool.query(
      `INSERT INTO origins (id, org_id, origin, status, method, token, verified_at, created_at)
       VALUES ($1,$2,$3,'verified','http_file','tok', now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [`orig_stub_arxiv_${arxivAddr.port}`, bountyOrgId, arxivOrigin],
    );
    await pool.query(
      `INSERT INTO origins (id, org_id, origin, status, method, token, verified_at, created_at)
       VALUES ($1,$2,$3,'verified','http_file','tok', now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [`orig_stub_arxiv_org_${arxivAddr.port}`, bountyOrgId, 'https://arxiv.org'],
    );

    const descriptor = {
      schema_version: 'v1',
      type: 'openclaw_universal_worker_test',
      capability_tags: ['screenshot', 'llm_summarize'],
      // Provide an idea so the worker can fetch real arXiv references via API.
      input_spec: { url: 'https://example.com', idea: 'test' },
      output_spec: {
        required_artifacts: [
          { kind: 'screenshot', count: 1 },
          { kind: 'other', count: 1, label_prefix: 'references' },
        ],
      },
    };
    await pool.query('UPDATE jobs SET task_descriptor=$1 WHERE id=$2', [JSON.stringify(descriptor), job.jobId]);

    const mockOpenClaw = await makeMockOpenClawBin();
    const profile = 'pw-test-profile';
    const scriptPath = 'integrations/openclaw/skills/proofwork-universal-worker/scripts/proofwork_worker.mjs';
    let run: { code: number | null; stdout: string; stderr: string } = { code: 1, stdout: '', stderr: '' };
    try {
      run = await runNodeScript({
        scriptPath,
        cwd: process.cwd(),
        env: {
          ONCE: 'true',
          PROOFWORK_API_BASE_URL: baseUrl,
          PROOFWORK_WORKER_TOKEN: workerToken,
          PROOFWORK_SUPPORTED_CAPABILITY_TAGS: 'browser,http,screenshot,llm_summarize',
          PROOFWORK_CANARY_PERCENT: '100',
          OPENCLAW_BIN: mockOpenClaw,
          OPENCLAW_BROWSER_PROFILE: profile,
          MOCK_OPENCLAW_EXPECT_PROFILE: profile,
          // Do not use OpenClaw LLM in tests; force deterministic fallback.
          OPENCLAW_AGENT_ID: '',
          ARXIV_API_BASE_URL: arxivApiBaseUrl,
          ARXIV_MAX_RESULTS: '1',
        },
      });
    } finally {
      await new Promise<void>((resolve) => arxivServer.close(() => resolve()));
    }
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
    const profile = 'pw-test-profile';
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
        OPENCLAW_BROWSER_PROFILE: profile,
        MOCK_OPENCLAW_EXPECT_PROFILE: profile,
      },
    });
    expect(run.code).toBe(0);

    const row = await getJob(job.jobId);
    expect(row?.status).toBe('open');
    expect(row?.leaseWorkerId).toBeUndefined();
  });

  it('degrades browser capabilities when OpenClaw browser actions are unhealthy and still completes http-only jobs', async () => {
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { openclaw: true } });
    const workerToken = reg.body.token as string;

    // Start a local HTTP origin to exercise the http module without external network.
    const siteServer = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (u.pathname === '/ok') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('ok');
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    siteServer.listen(0, '127.0.0.1');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await once(siteServer, 'listening');
    const addr: any = siteServer.address();
    const origin = `http://127.0.0.1:${addr.port}`;
    const httpUrl = `${origin}/ok`;

    const idsRes = await pool.query<{ id: string; bounty_id: string }>('SELECT id, bounty_id FROM jobs ORDER BY created_at ASC LIMIT 2');
    expect(idsRes.rows.length).toBeGreaterThanOrEqual(2);
    const [jobBrowser, jobHttp] = idsRes.rows;
    await pool.query('DELETE FROM jobs WHERE id <> $1 AND id <> $2', [jobBrowser.id, jobHttp.id]);

    // Verify the local origin and restrict both bounties so /jobs/next can offer these jobs.
    const bountyIds = Array.from(new Set([jobBrowser.bounty_id, jobHttp.bounty_id]));
    for (const bountyId of bountyIds) {
      const bountyRes = await pool.query<{ org_id: string }>('SELECT org_id FROM bounties WHERE id = $1', [bountyId]);
      const orgId = String(bountyRes.rows[0]?.org_id ?? '');
      expect(orgId).toBeTruthy();
      await pool.query(
        `INSERT INTO origins(id, org_id, origin, status, method, token, verified_at)
         VALUES ($1, $2, $3, 'verified', 'manual', 't', now())
         ON CONFLICT (org_id, origin) DO UPDATE SET status='verified', verified_at=now()`,
        [`orig_${Date.now()}_${Math.random().toString(16).slice(2)}`, orgId, origin]
      );
      await pool.query('UPDATE bounties SET allowed_origins=$1 WHERE id=$2', [JSON.stringify([origin]), bountyId]);
    }

    const browserDescriptor = {
      schema_version: 'v1',
      type: 'browser_unhealthy_job',
      capability_tags: ['browser', 'screenshot'],
      input_spec: { url: `${origin}/page` },
      output_spec: { required_artifacts: [{ kind: 'screenshot', count: 1 }] },
      freshness_sla_sec: 3600,
    };
    const httpDescriptor = {
      schema_version: 'v1',
      type: 'http_only_job',
      capability_tags: ['http'],
      input_spec: { url: httpUrl },
      output_spec: { http_response: true, required_artifacts: [{ kind: 'log', count: 1, label: 'report_http' }] },
      freshness_sla_sec: 3600,
    };
    await pool.query('UPDATE jobs SET task_descriptor=$1 WHERE id=$2', [JSON.stringify(browserDescriptor), jobBrowser.id]);
    await pool.query('UPDATE jobs SET task_descriptor=$1 WHERE id=$2', [JSON.stringify(httpDescriptor), jobHttp.id]);

    const mockOpenClaw = await makeMockOpenClawBin();
    const profile = 'pw-test-profile';
    const scriptPath = 'integrations/openclaw/skills/proofwork-universal-worker/scripts/proofwork_worker.mjs';
    const run = await runNodeScript({
      scriptPath,
      cwd: process.cwd(),
      env: {
        ONCE: 'true',
        PROOFWORK_API_BASE_URL: baseUrl,
        PROOFWORK_WORKER_TOKEN: workerToken,
        PROOFWORK_SUPPORTED_CAPABILITY_TAGS: 'browser,http,screenshot',
        PROOFWORK_CANARY_PERCENT: '100',
        OPENCLAW_BIN: mockOpenClaw,
        OPENCLAW_BROWSER_PROFILE: profile,
        MOCK_OPENCLAW_EXPECT_PROFILE: profile,
        // Force the health probe's interactive snapshot to fail (simulates missing Playwright).
        MOCK_OPENCLAW_FAIL_SNAPSHOT: 'true',
      },
    });

    await new Promise<void>((resolve) => siteServer.close(() => resolve()));
    if (run.code !== 0) {
      // eslint-disable-next-line no-console
      console.log('openclaw worker stdout:\n', run.stdout);
      // eslint-disable-next-line no-console
      console.log('openclaw worker stderr:\n', run.stderr);
    }
    expect(run.code).toBe(0);

    const a = await getJob(jobBrowser.id);
    const b = await getJob(jobHttp.id);
    expect(a?.status).toBe('open');
    expect(a?.leaseWorkerId).toBeUndefined();
    expect(b?.status).toBe('verifying');
    expect(b?.currentSubmissionId).toBeTruthy();
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
	            { op: 'extract', key: 'status_text', role: 'button', name: 'Continue', kind: 'text' },
	            { op: 'screenshot', label: 'after_flow', full_page: true },
	          ],
	        },
	      },
      output_spec: { required_artifacts: [{ kind: 'screenshot', count: 1 }, { kind: 'log', count: 1, label_prefix: 'report' }] },
      freshness_sla_sec: 3600,
    };
    await pool.query('UPDATE jobs SET task_descriptor=$1 WHERE id=$2', [JSON.stringify(descriptor), job.jobId]);

    const mockOpenClaw = await makeMockOpenClawBin();
    const profile = 'pw-test-profile';
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
        OPENCLAW_BROWSER_PROFILE: profile,
        MOCK_OPENCLAW_EXPECT_PROFILE: profile,
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

	    const flowArt = (sub?.artifactIndex ?? []).find((a: any) => String(a.label) === 'browser_flow');
	    expect(flowArt).toBeTruthy();
	    const flowUrl = String(flowArt?.url ?? '');
	    const m = flowUrl.match(/\/api\/artifacts\/([^/]+)\/download/);
	    expect(m?.[1]).toBeTruthy();
	    const dl = await request(app.server)
	      .get(`/api/artifacts/${m?.[1]}/download`)
	      .set('Authorization', `Bearer ${workerToken}`);
	    expect(dl.status).toBe(200);
	    expect(String(dl.text ?? dl.body ?? '')).toContain('"status_text": "ok"');
	  });

  it('persists a worker token to file and reuses it across restarts', async () => {
    // No jobs: worker should register (once), poll, and exit in ONCE mode.
    await pool.query('DELETE FROM jobs');

    const tokenDir = await mkdtemp(join(tmpdir(), 'pw-worker-token-'));
    const tokenFile = join(tokenDir, 'worker-token.json');

    const scriptPath = 'integrations/openclaw/skills/proofwork-universal-worker/scripts/proofwork_worker.mjs';
    const run1 = await runNodeScript({
      scriptPath,
      cwd: process.cwd(),
      env: {
        ONCE: 'true',
        PROOFWORK_API_BASE_URL: baseUrl,
        PROOFWORK_WORKER_TOKEN_FILE: tokenFile,
        PROOFWORK_SUPPORTED_CAPABILITY_TAGS: 'browser,http,screenshot,llm_summarize',
        PROOFWORK_CANARY_PERCENT: '100',
      },
    });
    expect(run1.code).toBe(0);

    const count1 = await pool.query<{ c: string }>('SELECT count(*)::text as c FROM workers');
    expect(Number(count1.rows[0]?.c ?? 0)).toBe(1);

    const run2 = await runNodeScript({
      scriptPath,
      cwd: process.cwd(),
      env: {
        ONCE: 'true',
        PROOFWORK_API_BASE_URL: baseUrl,
        PROOFWORK_WORKER_TOKEN_FILE: tokenFile,
        PROOFWORK_SUPPORTED_CAPABILITY_TAGS: 'browser,http,screenshot,llm_summarize',
        PROOFWORK_CANARY_PERCENT: '100',
      },
    });
    expect(run2.code).toBe(0);

    const count2 = await pool.query<{ c: string }>('SELECT count(*)::text as c FROM workers');
    expect(Number(count2.rows[0]?.c ?? 0)).toBe(1);
  });

  it('skips unsafe jobs (origin/login) and claims the next safe job using exclude_job_ids', async () => {
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { openclaw: true } });
    const workerToken = reg.body.token as string;

    const idsRes = await pool.query<{ id: string }>('SELECT id FROM jobs ORDER BY created_at ASC LIMIT 3');
    expect(idsRes.rows.length).toBeGreaterThanOrEqual(3);
    const [jobA, jobB, jobC] = idsRes.rows.map((r) => r.id);
    await pool.query('DELETE FROM jobs WHERE id <> $1 AND id <> $2 AND id <> $3', [jobA, jobB, jobC]);

    const baseDescriptor = {
      schema_version: 'v1',
      capability_tags: ['screenshot', 'llm_summarize'],
      output_spec: { required_artifacts: [{ kind: 'screenshot', count: 1 }, { kind: 'log', count: 1, label_prefix: 'report' }] },
      freshness_sla_sec: 3600,
    };

    const badOrigin = { ...baseDescriptor, type: 'bad_origin', input_spec: { url: 'https://evil.com' } };
    const badLogin = { ...baseDescriptor, type: 'bad_login', input_spec: { url: 'https://example.com/login' } };
    const good = { ...baseDescriptor, type: 'good', input_spec: { url: 'https://example.com' } };

    await pool.query('UPDATE jobs SET task_descriptor=$1 WHERE id=$2', [JSON.stringify(badOrigin), jobA]);
    await pool.query('UPDATE jobs SET task_descriptor=$1 WHERE id=$2', [JSON.stringify(badLogin), jobB]);
    await pool.query('UPDATE jobs SET task_descriptor=$1 WHERE id=$2', [JSON.stringify(good), jobC]);

    const mockOpenClaw = await makeMockOpenClawBin();
    const profile = 'pw-test-profile';
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
        OPENCLAW_BROWSER_PROFILE: profile,
        MOCK_OPENCLAW_EXPECT_PROFILE: profile,
      },
    });
    if (run.code !== 0) {
      // eslint-disable-next-line no-console
      console.log('openclaw worker stdout:\n', run.stdout);
      // eslint-disable-next-line no-console
      console.log('openclaw worker stderr:\n', run.stderr);
    }
    expect(run.code).toBe(0);

    const a = await getJob(jobA);
    const b = await getJob(jobB);
    const c = await getJob(jobC);
    expect(a?.status).toBe('open');
    expect(a?.leaseWorkerId).toBeUndefined();
    expect(b?.status).toBe('open');
    expect(b?.leaseWorkerId).toBeUndefined();
    expect(c?.status).toBe('verifying');
    expect(c?.currentSubmissionId).toBeTruthy();
  });

  it('releases a claimed job early when the browser redirects off allowed origins', async () => {
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { openclaw: true } });
    const workerToken = reg.body.token as string;

    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${workerToken}`);
    expect(next.status).toBe(200);
    expect(next.body.state).toBe('claimable');
    const job = next.body.data.job;
    await pool.query('DELETE FROM jobs WHERE id <> $1', [job.jobId]);

    const descriptor = {
      schema_version: 'v1',
      type: 'redirect_off_origin_test',
      capability_tags: ['screenshot', 'llm_summarize'],
      input_spec: { url: 'https://example.com' },
      output_spec: { required_artifacts: [{ kind: 'screenshot', count: 1 }, { kind: 'log', count: 1, label_prefix: 'report' }] },
      freshness_sla_sec: 3600,
    };
    await pool.query('UPDATE jobs SET task_descriptor=$1 WHERE id=$2', [JSON.stringify(descriptor), job.jobId]);

    const mockOpenClaw = await makeMockOpenClawBin();
    const profile = 'pw-test-profile';
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
        OPENCLAW_BROWSER_PROFILE: profile,
        MOCK_OPENCLAW_EXPECT_PROFILE: profile,
        // Simulate a redirect: location.href resolves to a disallowed origin even though startUrl is allowed.
        MOCK_OPENCLAW_FORCE_LOCATION_HREF: 'https://evil.com/',
      },
    });
    expect(run.code).toBe(0);

    const updated = await getJob(job.jobId);
    expect(updated?.status).toBe('open');
    expect(updated?.leaseWorkerId).toBeUndefined();
    expect(updated?.currentSubmissionId).toBeUndefined();
  });

  it('detects off-origin navigation after a click in browser_flow (runtime origin enforcement)', async () => {
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { openclaw: true } });
    const workerToken = reg.body.token as string;

    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${workerToken}`);
    expect(next.status).toBe(200);
    expect(next.body.state).toBe('claimable');
    const job = next.body.data.job;
    await pool.query('DELETE FROM jobs WHERE id <> $1', [job.jobId]);

    const descriptor = {
      schema_version: 'v1',
      type: 'click_off_origin_test',
      capability_tags: ['browser', 'screenshot', 'llm_summarize'],
      input_spec: { url: 'https://example.com' },
      site_profile: { browser_flow: { steps: [{ op: 'click', role: 'button', name: 'Continue' }] } },
      output_spec: { required_artifacts: [{ kind: 'screenshot', count: 1 }] },
      freshness_sla_sec: 3600,
    };
    await pool.query('UPDATE jobs SET task_descriptor=$1 WHERE id=$2', [JSON.stringify(descriptor), job.jobId]);

    const mockOpenClaw = await makeMockOpenClawBin();
    const profile = 'pw-test-profile';
    const stateDir = await mkdtemp(join(tmpdir(), 'mock-openclaw-state-'));
    const stateFile = join(stateDir, 'state.json');
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
        OPENCLAW_BROWSER_PROFILE: profile,
        MOCK_OPENCLAW_EXPECT_PROFILE: profile,
        MOCK_OPENCLAW_STATE_FILE: stateFile,
        MOCK_OPENCLAW_AFTER_CLICK_URL: 'https://evil.com/',
      },
    });
    expect(run.code).toBe(0);

    const updated = await getJob(job.jobId);
    expect(updated?.status).toBe('open');
    expect(updated?.leaseWorkerId).toBeUndefined();
    expect(updated?.currentSubmissionId).toBeUndefined();
  });

  it('enforces PROOFWORK_HTTP_MAX_BYTES (streams + truncates large responses)', async () => {
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { openclaw: true } });
    const workerToken = reg.body.token as string;

    // Start a local HTTP origin to exercise streaming limits without external network.
    const big = 'x'.repeat(2000);
    const siteServer = createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(big);
    });
    siteServer.listen(0, '127.0.0.1');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await once(siteServer, 'listening');
    const addr: any = siteServer.address();
    const origin = `http://127.0.0.1:${addr.port}`;
    const url = `${origin}/big`;

    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${workerToken}`);
    expect(next.status).toBe(200);
    expect(next.body.state).toBe('claimable');
    const job = next.body.data.job;
    await pool.query('DELETE FROM jobs WHERE id <> $1', [job.jobId]);

    // Mark this origin as verified and restrict the bounty to it so /jobs/next can offer it.
    const bountyRes = await pool.query<{ org_id: string }>('SELECT org_id FROM bounties WHERE id = $1', [job.bountyId]);
    const orgId = String(bountyRes.rows[0]?.org_id ?? '');
    expect(orgId).toBeTruthy();
    await pool.query(
      `INSERT INTO origins(id, org_id, origin, status, method, token, verified_at)
       VALUES ($1, $2, $3, 'verified', 'manual', 't', now())
       ON CONFLICT (org_id, origin) DO UPDATE SET status='verified', verified_at=now()`,
      [`orig_${Date.now()}`, orgId, origin]
    );
    await pool.query('UPDATE bounties SET allowed_origins=$1 WHERE id=$2', [JSON.stringify([origin]), job.bountyId]);

    const descriptor = {
      schema_version: 'v1',
      type: 'http_truncate_test',
      capability_tags: ['http', 'llm_summarize'],
      input_spec: { url },
      output_spec: { http_response: true, required_artifacts: [{ kind: 'log', count: 1, label_prefix: 'report' }] },
      freshness_sla_sec: 3600,
    };
    await pool.query('UPDATE jobs SET task_descriptor=$1 WHERE id=$2', [JSON.stringify(descriptor), job.jobId]);

    const scriptPath = 'integrations/openclaw/skills/proofwork-universal-worker/scripts/proofwork_worker.mjs';
    const run = await runNodeScript({
      scriptPath,
      cwd: process.cwd(),
      env: {
        ONCE: 'true',
        PROOFWORK_API_BASE_URL: baseUrl,
        PROOFWORK_WORKER_TOKEN: workerToken,
        PROOFWORK_SUPPORTED_CAPABILITY_TAGS: 'http,llm_summarize',
        PROOFWORK_CANARY_PERCENT: '100',
        PROOFWORK_HTTP_MAX_BYTES: '100',
      },
    });
    await new Promise<void>((resolve) => siteServer.close(() => resolve()));
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
    const httpArt = (sub?.artifactIndex ?? []).find((a: any) => String(a.label) === 'report_http');
    expect(httpArt).toBeTruthy();
    const finalUrl = String((httpArt as any)?.url ?? '');
    const m = finalUrl.match(/\/api\/artifacts\/([^/]+)\/download/);
    expect(m?.[1]).toBeTruthy();

    const dl = await request(app.server)
      .get(`/api/artifacts/${m?.[1]}/download`)
      .set('Authorization', `Bearer ${workerToken}`);
    expect(dl.status).toBe(200);
    expect(String(dl.text ?? dl.body ?? '')).toContain('truncated: true');
  });

  it('refuses browser_flow value_env when not explicitly allowlisted', async () => {
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { openclaw: true } });
    const workerToken = reg.body.token as string;

    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${workerToken}`);
    expect(next.status).toBe(200);
    expect(next.body.state).toBe('claimable');
    const job = next.body.data.job;
    await pool.query('DELETE FROM jobs WHERE id <> $1', [job.jobId]);

    const descriptor = {
      schema_version: 'v1',
      type: 'value_env_blocked_test',
      capability_tags: ['browser', 'screenshot', 'llm_summarize'],
      input_spec: { url: 'https://example.com' },
      site_profile: { browser_flow: { steps: [{ op: 'fill', role: 'textbox', name: 'Email', value_env: 'NOT_ALLOWED' }] } },
      output_spec: { required_artifacts: [{ kind: 'screenshot', count: 1 }] },
      freshness_sla_sec: 3600,
    };
    await pool.query('UPDATE jobs SET task_descriptor=$1 WHERE id=$2', [JSON.stringify(descriptor), job.jobId]);

    const mockOpenClaw = await makeMockOpenClawBin();
    const profile = 'pw-test-profile';
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
        OPENCLAW_BROWSER_PROFILE: profile,
        MOCK_OPENCLAW_EXPECT_PROFILE: profile,
      },
    });
    expect(run.code).toBe(0);

    const updated = await getJob(job.jobId);
    expect(updated?.status).toBe('open');
    expect(updated?.leaseWorkerId).toBeUndefined();
  });

  it('refuses browser_flow extract.fn (no arbitrary JS)', async () => {
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { openclaw: true } });
    const workerToken = reg.body.token as string;

    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${workerToken}`);
    expect(next.status).toBe(200);
    expect(next.body.state).toBe('claimable');
    const job = next.body.data.job;
    await pool.query('DELETE FROM jobs WHERE id <> $1', [job.jobId]);

    const descriptor = {
      schema_version: 'v1',
      type: 'extract_fn_blocked_test',
      capability_tags: ['browser', 'screenshot', 'llm_summarize'],
      input_spec: { url: 'https://example.com' },
      site_profile: { browser_flow: { steps: [{ op: 'extract', key: 'x', role: 'button', name: 'Continue', fn: '() => document.title' }] } },
      output_spec: { required_artifacts: [{ kind: 'screenshot', count: 1 }] },
      freshness_sla_sec: 3600,
    };
    await pool.query('UPDATE jobs SET task_descriptor=$1 WHERE id=$2', [JSON.stringify(descriptor), job.jobId]);

    const mockOpenClaw = await makeMockOpenClawBin();
    const profile = 'pw-test-profile';
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
        OPENCLAW_BROWSER_PROFILE: profile,
        MOCK_OPENCLAW_EXPECT_PROFILE: profile,
      },
    });
    expect(run.code).toBe(0);

    const updated = await getJob(job.jobId);
    expect(updated?.status).toBe('open');
    expect(updated?.leaseWorkerId).toBeUndefined();
  });

  it('refuses browser_flow with more than 100 steps (bounded descriptor)', async () => {
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { openclaw: true } });
    const workerToken = reg.body.token as string;

    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${workerToken}`);
    expect(next.status).toBe(200);
    expect(next.body.state).toBe('claimable');
    const job = next.body.data.job;
    await pool.query('DELETE FROM jobs WHERE id <> $1', [job.jobId]);

    const steps = Array.from({ length: 101 }, () => ({ op: 'wait', ms: 1 }));
    const descriptor = {
      schema_version: 'v1',
      type: 'browser_flow_too_many_steps',
      capability_tags: ['browser', 'screenshot', 'llm_summarize'],
      input_spec: { url: 'https://example.com' },
      site_profile: { browser_flow: { steps } },
      output_spec: { required_artifacts: [{ kind: 'screenshot', count: 1 }] },
      freshness_sla_sec: 3600,
    };
    await pool.query('UPDATE jobs SET task_descriptor=$1 WHERE id=$2', [JSON.stringify(descriptor), job.jobId]);

    const mockOpenClaw = await makeMockOpenClawBin();
    const profile = 'pw-test-profile';
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
        OPENCLAW_BROWSER_PROFILE: profile,
        MOCK_OPENCLAW_EXPECT_PROFILE: profile,
      },
    });
    expect(run.code).toBe(0);

    const updated = await getJob(job.jobId);
    expect(updated?.status).toBe('open');
    expect(updated?.leaseWorkerId).toBeUndefined();
  });
});
