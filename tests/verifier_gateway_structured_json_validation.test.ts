import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createHash } from 'crypto';
import { buildServer } from '../src/server.js';
import { pool } from '../src/db/client.js';
import { resetStore } from '../src/store.js';

function sha256Hex(buf: Buffer) {
  return createHash('sha256').update(buf).digest('hex');
}

describe('Verifier gateway (structured JSON outputs)', () => {
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

  async function putJsonFile(token: string, jobId: string, filename: string, obj: any) {
    const bytes = Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf8');
    const presign = await request(app.server)
      .post('/api/uploads/presign')
      .set('Authorization', `Bearer ${token}`)
      .send({ jobId, files: [{ filename, contentType: 'application/json', sizeBytes: bytes.byteLength }] });
    expect(presign.status).toBe(200);
    const u = presign.body.uploads[0];
    const p = new URL(u.url).pathname;
    const put = await request(app.server).put(p).set('Authorization', `Bearer ${token}`).set(u.headers || {}).send(bytes.toString('utf8'));
    expect(put.status).toBe(200);
    return { u, bytes };
  }

  it('passes when required structured JSON artifacts are present and well-formed', async () => {
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
      type: 'universal_structured_json',
      capability_tags: ['http'],
      input_spec: {},
      output_spec: {
        required_artifacts: [
          { kind: 'other', count: 1, label_prefix: 'results' },
          { kind: 'other', count: 1, label_prefix: 'deals' },
          { kind: 'other', count: 1, label_prefix: 'rows' },
          { kind: 'other', count: 1, label_prefix: 'repos' },
          { kind: 'other', count: 1, label_prefix: 'references' },
          { kind: 'other', count: 1, label_prefix: 'ingest' },
        ],
      },
    };
    await pool.query('UPDATE jobs SET task_descriptor=$1 WHERE id=$2', [JSON.stringify(descriptor), job.jobId]);

    const upResults = await putJsonFile(token, job.jobId, 'results.json', {
      schema: 'results.v1',
      items: [{ url: 'https://example.com/item', title: 'item' }],
    });
    const upDeals = await putJsonFile(token, job.jobId, 'deals.json', {
      schema: 'deals.v1',
      deals: [{ url: 'https://example.com/deal', price: 199, currency: 'USD' }],
    });
    const upRows = await putJsonFile(token, job.jobId, 'rows.json', {
      schema: 'rows.v1',
      rows: [{ title: 'Engineer', url: 'https://example.com/job' }],
    });
    const upRepos = await putJsonFile(token, job.jobId, 'repos.json', {
      schema: 'repos.v1',
      repos: [{ name: 'example/repo', url: 'https://github.com/example/repo', license: 'MIT' }],
    });
    const upRefs = await putJsonFile(token, job.jobId, 'references.json', {
      schema: 'references.v1',
      references: [{ id: 'arxiv:0000.00000', url: 'https://arxiv.org/abs/0000.00000' }],
    });
    const upIngest = await putJsonFile(token, job.jobId, 'ingest.json', {
      schema: 'github_ingest.v1',
      fetched_events: 2,
      ingest: { ok: true, inserted: 2, skipped: 0, lastEventId: '2', sourceId: 'worker:test' },
    });

    const artifactIndex = [
      {
        kind: 'other',
        label: 'results_main',
        sha256: sha256Hex(upResults.bytes),
        url: upResults.u.finalUrl,
        sizeBytes: upResults.bytes.byteLength,
        contentType: 'application/json',
      },
      {
        kind: 'other',
        label: 'deals_main',
        sha256: sha256Hex(upDeals.bytes),
        url: upDeals.u.finalUrl,
        sizeBytes: upDeals.bytes.byteLength,
        contentType: 'application/json',
      },
      {
        kind: 'other',
        label: 'rows_main',
        sha256: sha256Hex(upRows.bytes),
        url: upRows.u.finalUrl,
        sizeBytes: upRows.bytes.byteLength,
        contentType: 'application/json',
      },
      {
        kind: 'other',
        label: 'repos_main',
        sha256: sha256Hex(upRepos.bytes),
        url: upRepos.u.finalUrl,
        sizeBytes: upRepos.bytes.byteLength,
        contentType: 'application/json',
      },
      {
        kind: 'other',
        label: 'references_main',
        sha256: sha256Hex(upRefs.bytes),
        url: upRefs.u.finalUrl,
        sizeBytes: upRefs.bytes.byteLength,
        contentType: 'application/json',
      },
      {
        kind: 'other',
        label: 'ingest_main',
        sha256: sha256Hex(upIngest.bytes),
        url: upIngest.u.finalUrl,
        sizeBytes: upIngest.bytes.byteLength,
        contentType: 'application/json',
      },
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

  it('fails deterministically when required ingest.json indicates ingest failed', async () => {
    const { buildVerifierGateway } = await import('../services/verifier-gateway/server.js');
    const gw = buildVerifierGateway();

    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { browser: true } });
    const token = reg.body.token as string;

    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${token}`);
    const job = next.body.data.job;
    await request(app.server).post(`/api/jobs/${job.jobId}/claim`).set('Authorization', `Bearer ${token}`).send();

    const descriptor = {
      schema_version: 'v1',
      type: 'github_ingest_events',
      capability_tags: ['http'],
      input_spec: {},
      output_spec: { required_artifacts: [{ kind: 'other', count: 1, label_prefix: 'ingest' }] },
    };
    await pool.query('UPDATE jobs SET task_descriptor=$1 WHERE id=$2', [JSON.stringify(descriptor), job.jobId]);

    const upIngest = await putJsonFile(token, job.jobId, 'ingest.json', {
      schema: 'github_ingest.v1',
      fetched_events: 2,
      ingest: { ok: false, error: 'upstream_failed' },
    });

    const artifactIndex = [
      {
        kind: 'other',
        label: 'ingest_main',
        sha256: sha256Hex(upIngest.bytes),
        url: upIngest.u.finalUrl,
        sizeBytes: upIngest.bytes.byteLength,
        contentType: 'application/json',
      },
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
    expect(body.verdict).toBe('fail');
    expect(body.reason).toBe('ingest_artifact_ingest_not_ok');
  });

  it('fails deterministically when a required repos.json entry is missing license', async () => {
    const { buildVerifierGateway } = await import('../services/verifier-gateway/server.js');
    const gw = buildVerifierGateway();

    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { browser: true } });
    const token = reg.body.token as string;

    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${token}`);
    const job = next.body.data.job;
    await request(app.server).post(`/api/jobs/${job.jobId}/claim`).set('Authorization', `Bearer ${token}`).send();

    const descriptor = {
      schema_version: 'v1',
      type: 'github_scan',
      capability_tags: ['http'],
      input_spec: {},
      output_spec: { required_artifacts: [{ kind: 'other', count: 1, label_prefix: 'repos' }] },
    };
    await pool.query('UPDATE jobs SET task_descriptor=$1 WHERE id=$2', [JSON.stringify(descriptor), job.jobId]);

    const upRepos = await putJsonFile(token, job.jobId, 'repos.json', {
      schema: 'repos.v1',
      repos: [{ name: 'example/repo', url: 'https://github.com/example/repo' }],
    });

    const artifactIndex = [
      {
        kind: 'other',
        label: 'repos_main',
        sha256: sha256Hex(upRepos.bytes),
        url: upRepos.u.finalUrl,
        sizeBytes: upRepos.bytes.byteLength,
        contentType: 'application/json',
      },
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
    expect(body.verdict).toBe('fail');
    expect(String(body.reason)).toContain('repos_artifact_json_repos_item_missing_license');
  });
});
