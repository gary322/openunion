import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createHash } from 'crypto';
import { buildServer } from '../src/server.js';
import { pool } from '../src/db/client.js';
import { resetStore } from '../src/store.js';

function sha256Hex(buf: Buffer) {
  return createHash('sha256').update(buf).digest('hex');
}

function minimalMp4Bytes() {
  // [size=24][ftyp][major_brand=isom] – enough for scanner + verifier sniff.
  return Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  ]);
}

describe('Verifier gateway (descriptor-bound content validation)', () => {
  const verifierToken = 'pw_vf_internal';
  let app: any;
  let baseUrl: string;
  let restoreEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    await resetStore();
    app = buildServer();
    await app.ready();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    // Ensure verifier-gateway fetches artifacts from this test server.
    restoreEnv = { API_BASE_URL: process.env.API_BASE_URL, VERIFIER_TOKEN: process.env.VERIFIER_TOKEN };
    process.env.API_BASE_URL = baseUrl;
    process.env.VERIFIER_TOKEN = verifierToken;
    vi.resetModules();
  });

  afterEach(async () => {
    if (restoreEnv.API_BASE_URL === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = restoreEnv.API_BASE_URL;

    if (restoreEnv.VERIFIER_TOKEN === undefined) delete process.env.VERIFIER_TOKEN;
    else process.env.VERIFIER_TOKEN = restoreEnv.VERIFIER_TOKEN;
    await app.close();
  });

  it('passes for mp4 + timeline.json + report', async () => {
    const { buildVerifierGateway } = await import('../services/verifier-gateway/server.js');
    const gw = buildVerifierGateway();

    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { browser: true } });
    const token = reg.body.token as string;

    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${token}`);
    expect(next.status).toBe(200);
    const job = next.body.data.job;

    const claim = await request(app.server).post(`/api/jobs/${job.jobId}/claim`).set('Authorization', `Bearer ${token}`).send();
    expect(claim.status).toBe(200);

    const descriptor = {
      schema_version: 'v1',
      type: 'clips_highlights',
      capability_tags: ['ffmpeg', 'llm_summarize'],
      input_spec: { vod_url: 'https://vod.example/test', start_sec: 0, duration_sec: 10 },
      output_spec: {
        required_artifacts: [
          { kind: 'video', count: 1, label_prefix: 'clip' },
          { kind: 'other', count: 1, label_prefix: 'timeline' },
          { kind: 'log', count: 1, label_prefix: 'report' },
        ],
      },
      freshness_sla_sec: 3600,
    };

    await pool.query('UPDATE jobs SET task_descriptor=$1 WHERE id=$2', [JSON.stringify(descriptor), job.jobId]);

    const mp4 = minimalMp4Bytes();
    const timeline = Buffer.from(
      JSON.stringify(
        { schema: 'timeline.v1', vod_url: 'https://vod.example/test', clips: [{ start_sec: 0, end_sec: 10, label: 'clip_1' }] },
        null,
        2
      ) + '\n',
      'utf8'
    );
    const report = Buffer.from('report\n', 'utf8');

    const presign = await request(app.server)
      .post('/api/uploads/presign')
      .set('Authorization', `Bearer ${token}`)
      .send({
        jobId: job.jobId,
        files: [
          { filename: 'clip.mp4', contentType: 'video/mp4', sizeBytes: mp4.byteLength },
          { filename: 'timeline.json', contentType: 'application/json', sizeBytes: timeline.byteLength },
          { filename: 'report.txt', contentType: 'text/plain', sizeBytes: report.byteLength },
        ],
      });
    expect(presign.status).toBe(200);

    const uploads = presign.body.uploads as any[];
    const byName = (name: string) => uploads.find((u) => u.filename === name);
    const putFile = async (filename: string, bytes: Buffer | string) => {
      const u = byName(filename);
      expect(u?.url).toBeTruthy();
      const p = new URL(u.url).pathname;
      const res = await request(app.server).put(p).set('Authorization', `Bearer ${token}`).set(u.headers || {}).send(bytes);
      expect(res.status).toBe(200);
      return u;
    };

    const upMp4 = await putFile('clip.mp4', mp4);
    const upTimeline = await putFile('timeline.json', timeline.toString('utf8'));
    const upReport = await putFile('report.txt', report);

    // Sanity-check what the platform stored for the JSON artifact (upload handler may re-serialize).
    const timelineIdMatch = new URL(upTimeline.finalUrl).pathname.match(/^\/api\/artifacts\/([^/]+)\/download$/);
    expect(timelineIdMatch).toBeTruthy();
    const timelineId = timelineIdMatch?.[1] as string;
    const tlResp = await fetch(`${baseUrl}/api/artifacts/${timelineId}/download`, { headers: { Authorization: `Bearer ${verifierToken}` } });
    expect(tlResp.ok).toBe(true);
    const tlJson = await tlResp.json();
    expect(Array.isArray((tlJson as any)?.clips)).toBe(true);

    const artifactIndex = [
      { kind: 'video', label: 'clip_main', sha256: sha256Hex(mp4), url: upMp4.finalUrl, sizeBytes: mp4.byteLength, contentType: 'video/mp4' },
      { kind: 'other', label: 'timeline_main', sha256: sha256Hex(timeline), url: upTimeline.finalUrl, sizeBytes: timeline.byteLength, contentType: 'application/json' },
      { kind: 'log', label: 'report_summary', sha256: sha256Hex(report), url: upReport.finalUrl, sizeBytes: report.byteLength, contentType: 'text/plain' },
    ];

    const manifest = {
      manifestVersion: '1.0',
      jobId: job.jobId,
      bountyId: job.bountyId,
      finalUrl: job.journey.startUrl,
      worker: { workerId: reg.body.workerId, skillVersion: 'test', fingerprint: { fingerprintClass: job.environment.fingerprintClass } },
      result: { outcome: 'failure', failureType: 'other', severity: 'low', expected: 'expected output ok', observed: 'observed output ok', reproConfidence: 'high' },
      reproSteps: ['upload artifacts', 'submit'],
      artifacts: artifactIndex,
    };

    const submit = await request(app.server)
      .post(`/api/jobs/${job.jobId}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', `idem_${Date.now()}`)
      .send({ manifest, artifactIndex });
    expect(submit.status).toBe(200);
    const submissionId = submit.body.data.submission.id as string;

    const claimVer = await request(app.server)
      .post('/api/verifier/claim')
      .set('Authorization', `Bearer ${verifierToken}`)
      .send({ submissionId, attemptNo: 1, messageId: 'm', idempotencyKey: 'idem', verifierInstanceId: 'v', claimTtlSec: 600 });
    expect(claimVer.status).toBe(200);

    const run = await gw.inject({
      method: 'POST',
      url: '/run',
      payload: {
        verificationId: claimVer.body.verificationId,
        submissionId,
        attemptNo: 1,
        jobSpec: claimVer.body.jobSpec,
        submission: claimVer.body.submission,
      },
    });
    expect(run.statusCode).toBe(200);
    const body = run.json() as any;
    expect(body.verdict).toBe('pass');
  });

  it('fails deterministically for a malformed timeline structure', async () => {
    const { buildVerifierGateway } = await import('../services/verifier-gateway/server.js');
    const gw = buildVerifierGateway();

    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { browser: true } });
    const token = reg.body.token as string;

    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${token}`);
    const job = next.body.data.job;

    await request(app.server).post(`/api/jobs/${job.jobId}/claim`).set('Authorization', `Bearer ${token}`).send();

    const descriptor = {
      schema_version: 'v1',
      type: 'clips_highlights',
      capability_tags: ['ffmpeg', 'llm_summarize'],
      input_spec: { vod_url: 'https://vod.example/test', start_sec: 0, duration_sec: 10 },
      output_spec: { required_artifacts: [{ kind: 'other', count: 1, label_prefix: 'timeline' }] },
    };
    await pool.query('UPDATE jobs SET task_descriptor=$1 WHERE id=$2', [JSON.stringify(descriptor), job.jobId]);

    const badTimeline = Buffer.from(JSON.stringify({ schema: 'timeline.v1', clips: [] }) + '\n', 'utf8');

    const presign = await request(app.server)
      .post('/api/uploads/presign')
      .set('Authorization', `Bearer ${token}`)
      .send({ jobId: job.jobId, files: [{ filename: 'timeline.json', contentType: 'application/json', sizeBytes: badTimeline.byteLength }] });
    const u = presign.body.uploads[0];
    const p = new URL(u.url).pathname;
    const put = await request(app.server).put(p).set('Authorization', `Bearer ${token}`).set(u.headers || {}).send(badTimeline.toString('utf8'));
    expect(put.status).toBe(200);

    const artifactIndex = [{ kind: 'other', label: 'timeline_main', sha256: sha256Hex(badTimeline), url: u.finalUrl, sizeBytes: badTimeline.byteLength, contentType: 'application/json' }];

    const manifest = {
      manifestVersion: '1.0',
      jobId: job.jobId,
      bountyId: job.bountyId,
      finalUrl: job.journey.startUrl,
      worker: { workerId: reg.body.workerId, skillVersion: 'test', fingerprint: { fingerprintClass: job.environment.fingerprintClass } },
      result: { outcome: 'failure', failureType: 'other', severity: 'low', expected: 'ok', observed: 'ok', reproConfidence: 'high' },
      reproSteps: ['upload artifacts', 'submit'],
      artifacts: artifactIndex,
    };

    const submit = await request(app.server)
      .post(`/api/jobs/${job.jobId}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', `idem_${Date.now()}`)
      .send({ manifest, artifactIndex });
    expect(submit.status).toBe(200);
    const submissionId = submit.body.data.submission.id as string;

    const claimVer = await request(app.server)
      .post('/api/verifier/claim')
      .set('Authorization', `Bearer ${verifierToken}`)
      .send({ submissionId, attemptNo: 1, messageId: 'm', idempotencyKey: 'idem', verifierInstanceId: 'v', claimTtlSec: 600 });
    expect(claimVer.status).toBe(200);

    const run = await gw.inject({
      method: 'POST',
      url: '/run',
      payload: {
        verificationId: claimVer.body.verificationId,
        submissionId,
        attemptNo: 1,
        jobSpec: claimVer.body.jobSpec,
        submission: claimVer.body.submission,
      },
    });
    expect(run.statusCode).toBe(200);
    const body = run.json() as any;
    expect(body.verdict).toBe('fail');
    expect(String(body.reason)).toContain('timeline_artifact_missing_clips');
  });
});
