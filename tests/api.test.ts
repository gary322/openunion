import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { buildServer } from '../src/server.js';
import { pool } from '../src/db/client.js';
import { resetStore, listPayouts, getJob, updateJob } from '../src/store.js';
import { Wallet, getAddress } from 'ethers';

const VERIFIER_TOKEN = 'pw_vf_internal';

describe('Proofwork API happy path', () => {
  beforeEach(async () => {
    await resetStore();
  });

  it('registers worker, claims job, submits, verifies, completes', async () => {
    const app = buildServer();
    await app.ready();

    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { browser: true } });
    expect(reg.status).toBe(200);
    const token = reg.body.token as string;

    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${token}`);
    expect(next.body.state).toBe('claimable');
    const job = next.body.data.job;

    const claim = await request(app.server)
      .post(`/api/jobs/${job.jobId}/claim`)
      .set('Authorization', `Bearer ${token}`)
      .send();
    expect(claim.status).toBe(200);
    expect(claim.body.data.leaseNonce).toBeDefined();

    const presign = await request(app.server)
      .post('/api/uploads/presign')
      .set('Authorization', `Bearer ${token}`)
      .send({ jobId: job.jobId, files: [{ filename: 'shot.png', contentType: 'image/png' }] });
    expect(presign.status).toBe(200);

    // Upload in local-storage mode so artifacts can be attached/validated on submit.
    const upload = presign.body.uploads[0];
    const uploadPath = new URL(upload.url).pathname;
    const uploadRes = await request(app.server)
      .put(uploadPath)
      .set('Authorization', `Bearer ${token}`)
      .set(upload.headers || {})
      // minimal PNG header (scanner validates the signature)
      .send(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    expect(uploadRes.status).toBe(200);

    const artifact = {
      kind: 'screenshot',
      label: 'failure',
      sha256: 'abcd1234',
      url: presign.body.uploads[0].finalUrl,
    };

    const manifest = {
      manifestVersion: '1.0',
      jobId: job.jobId,
      bountyId: job.bountyId,
      finalUrl: 'https://example.com/end',
      worker: { workerId: reg.body.workerId, skillVersion: '1.0.0', fingerprint: { fingerprintClass: job.environment.fingerprintClass } },
      result: {
        outcome: 'failure',
        failureType: 'blocker',
        severity: 'high',
        expected: 'See success page',
        observed: 'Blank page',
        reproConfidence: 'high',
      },
      reproSteps: ['open', 'click', 'see blank'],
      artifacts: [artifact],
      suggestedChange: { type: 'bugfix', text: 'Fix blank screen' },
    };

    const submit = await request(app.server)
      .post(`/api/jobs/${job.jobId}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ manifest, artifactIndex: [artifact] });

    expect(submit.status).toBe(200);
    expect(submit.body.state).toBe('verifying');
    const submissionId = submit.body.data.submission.id;

    const claimVer = await request(app.server)
      .post('/api/verifier/claim')
      .set('Authorization', `Bearer ${VERIFIER_TOKEN}`)
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
      .set('Authorization', `Bearer ${VERIFIER_TOKEN}`)
      .send({
        verificationId,
        claimToken,
        submissionId,
        jobId: job.jobId,
        attemptNo: 1,
        verdict: 'pass',
        reason: 'Reproduced',
        scorecard: { R: 1, E: 0.9, A: 0.8, N: 1, T: 0.7, qualityScore: 92 },
        evidenceArtifacts: [artifact],
        runMetadata: { run: 'demo' },
      });
    expect(verdict.status).toBe(200);

    const jobStatus = await request(app.server)
      .get(`/api/jobs/${job.jobId}`)
      .set('Authorization', `Bearer ${token}`)
      .send();
    expect(jobStatus.body.status).toBe('done');
    expect(jobStatus.body.finalVerdict).toBe('pass');
  });

  it('returns idle when no open jobs remain', async () => {
    const app = buildServer();
    await app.ready();
    // remove all jobs after seeding to force idle
    await pool.query('DELETE FROM jobs');
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { browser: true } });
    const token = reg.body.token as string;
    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${token}`);
    expect(next.body.state).toBe('idle');
  });

  it("does not allow a worker to read another worker's job status (anti-enumeration)", async () => {
    const app = buildServer();
    await app.ready();

    const w1 = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { browser: true } });
    const t1 = w1.body.token as string;
    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${t1}`);
    const job = next.body.data.job;
    await request(app.server).post(`/api/jobs/${job.jobId}/claim`).set('Authorization', `Bearer ${t1}`).send();

    const w2 = await request(app.server).post('/api/workers/register').send({ displayName: 'B', capabilities: { browser: true } });
    const t2 = w2.body.token as string;
    const res = await request(app.server).get(`/api/jobs/${job.jobId}`).set('Authorization', `Bearer ${t2}`);
    expect(res.status).toBe(404);
  });

  it('blocks presign for blocked content types', async () => {
    process.env.BLOCKED_UPLOAD_CONTENT_TYPES = 'application/x-msdownload';
    const app = buildServer();
    await app.ready();

    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'B', capabilities: { browser: true } });
    const token = reg.body.token as string;

    // Ensure worker has an active job before presign
    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${token}`);
    const job = next.body.data.job;
    await request(app.server).post(`/api/jobs/${job.jobId}/claim`).set('Authorization', `Bearer ${token}`).send();

    const presign = await request(app.server)
      .post('/api/uploads/presign')
      .set('Authorization', `Bearer ${token}`)
      .send({ jobId: job.jobId, files: [{ filename: 'evil.exe', contentType: 'application/x-msdownload' }] });
    expect(presign.status).toBe(400);
    expect(presign.body.error.code).toBe('blocked_content_type');

    delete process.env.BLOCKED_UPLOAD_CONTENT_TYPES;
  });

  it('treats /api/jobs/:jobId/submit as idempotent when Idempotency-Key is provided', async () => {
    const app = buildServer();
    await app.ready();

    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'I', capabilities: { browser: true } });
    expect(reg.status).toBe(200);
    const token = reg.body.token as string;

    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${token}`);
    expect(next.body.state).toBe('claimable');
    const job = next.body.data.job;

    await request(app.server).post(`/api/jobs/${job.jobId}/claim`).set('Authorization', `Bearer ${token}`).send();

    const artifact = { kind: 'screenshot', label: 'proof', sha256: 'abcd1234', url: 'https://example.com/proof.png' };
    const baseManifest = {
      manifestVersion: '1.0',
      jobId: job.jobId,
      bountyId: job.bountyId,
      worker: { workerId: reg.body.workerId, skillVersion: '1.0.0', fingerprint: { fingerprintClass: job.environment.fingerprintClass } },
      result: {
        outcome: 'failure',
        failureType: 'other',
        severity: 'low',
        expected: 'report produced',
        observed: 'report produced',
        reproConfidence: 'high',
      },
      reproSteps: ['step 1'],
      artifacts: [artifact],
    };

    const idemKey = 'idem_submit_1';

    const first = await request(app.server)
      .post(`/api/jobs/${job.jobId}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idemKey)
      .send({ manifest: baseManifest, artifactIndex: [artifact] });
    expect(first.status).toBe(200);
    expect(first.body.state).toBe('verifying');
    const submissionId1 = first.body.data.submission.id as string;

    const second = await request(app.server)
      .post(`/api/jobs/${job.jobId}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idemKey)
      .send({ manifest: baseManifest, artifactIndex: [artifact] });
    expect(second.status).toBe(200);
    expect(second.body.data.submission.id).toBe(submissionId1);

    const count = await pool.query<{ c: string }>('SELECT count(*)::text as c FROM submissions WHERE job_id = $1', [job.jobId]);
    expect(Number(count.rows[0]?.c ?? 0)).toBe(1);

    // Simulate a crash window where job.current_submission_id wasn't set, then retry with the same Idempotency-Key
    // but different payload: should be rejected to prevent accidental overwrite.
    await pool.query("UPDATE jobs SET current_submission_id = NULL, status = 'claimed' WHERE id = $1", [job.jobId]);
    const conflict = await request(app.server)
      .post(`/api/jobs/${job.jobId}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idemKey)
      .send({ manifest: { ...baseManifest, result: { ...baseManifest.result, observed: 'different' } }, artifactIndex: [artifact] });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('idempotency_conflict');
  });

  it('skips and rejects stale jobs when task_descriptor.freshness_sla_sec is exceeded', async () => {
    const app = buildServer();
    await app.ready();

    const keyResp = await request(app.server).post('/api/org/api-keys').send({ email: 'buyer@example.com', password: 'password', name: 'ci' });
    const buyerToken = keyResp.body.token;

    // Register the task type in the app registry so the bounty can be created.
    const regApp = await request(app.server)
      .post('/api/org/apps')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ slug: `drops-${Date.now()}`, taskType: 'drops', name: 'Drops' });
    expect(regApp.status).toBe(200);

    const bountyResp = await request(app.server)
      .post('/api/bounties')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({
        title: 'Freshness bounty',
        description: 'stale should not be claimable',
        allowedOrigins: ['https://example.com'],
        payoutCents: 5000,
        requiredProofs: 1,
        fingerprintClassesRequired: ['desktop_us'],
        taskDescriptor: {
          schema_version: 'v1',
          type: 'drops',
          capability_tags: ['http'],
          input_spec: {},
          output_spec: {},
          freshness_sla_sec: 1,
        },
      });
    expect(bountyResp.status).toBe(200);
    const bountyId = bountyResp.body.id;
    await request(app.server).post(`/api/bounties/${bountyId}/publish`).set('Authorization', `Bearer ${buyerToken}`).send();

    // Keep only the freshness-sensitive job.
    await pool.query('DELETE FROM jobs WHERE bounty_id <> $1', [bountyId]);

    const jobRow = await pool.query<{ id: string }>('SELECT id FROM jobs WHERE bounty_id=$1 LIMIT 1', [bountyId]);
    const jobId = jobRow.rows[0]?.id;
    expect(jobId).toBeTruthy();

    // Make it stale.
    await pool.query('UPDATE jobs SET created_at = $2 WHERE id = $1', [jobId, new Date(Date.now() - 120_000)]);

    const worker = await request(app.server).post('/api/workers/register').send({ displayName: 'fresh', capabilities: { browser: true } });
    const token = worker.body.token;

    const next = await request(app.server).get('/api/jobs/next').query({ capability_tag: 'http' }).set('Authorization', `Bearer ${token}`);
    expect(next.status).toBe(200);
    expect(next.body.state).toBe('idle');

    const claim = await request(app.server).post(`/api/jobs/${jobId}/claim`).set('Authorization', `Bearer ${token}`);
    expect(claim.status).toBe(409);
    expect(claim.body.error.code).toBe('stale_job');
  });

  it('rejects submission when job becomes stale after claim (freshness SLA enforced on submit)', async () => {
    const app = buildServer();
    await app.ready();

    const keyResp = await request(app.server).post('/api/org/api-keys').send({ email: 'buyer@example.com', password: 'password', name: 'ci' });
    const buyerToken = keyResp.body.token;

    // Register the task type in the app registry so the bounty can be created.
    const regApp = await request(app.server)
      .post('/api/org/apps')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ slug: `marketplace-${Date.now()}`, taskType: 'marketplace', name: 'Marketplace' });
    expect(regApp.status).toBe(200);

    const bountyResp = await request(app.server)
      .post('/api/bounties')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({
        title: 'Freshness submit bounty',
        description: 'stale should not be submittable',
        allowedOrigins: ['https://example.com'],
        payoutCents: 5000,
        requiredProofs: 1,
        fingerprintClassesRequired: ['desktop_us'],
        taskDescriptor: {
          schema_version: 'v1',
          type: 'marketplace',
          capability_tags: ['http'],
          input_spec: {},
          output_spec: {},
          freshness_sla_sec: 1,
        },
      });
    expect(bountyResp.status).toBe(200);
    await request(app.server).post(`/api/bounties/${bountyResp.body.id}/publish`).set('Authorization', `Bearer ${buyerToken}`).send();

    // Keep only the freshness-sensitive job.
    await pool.query('DELETE FROM jobs WHERE bounty_id <> $1', [bountyResp.body.id]);
    const jobRow = await pool.query<{ id: string }>('SELECT id FROM jobs WHERE bounty_id=$1 LIMIT 1', [bountyResp.body.id]);
    const jobId = jobRow.rows[0]?.id;
    expect(jobId).toBeTruthy();

    const worker = await request(app.server).post('/api/workers/register').send({ displayName: 'fresh_submit', capabilities: { browser: true } });
    const token = worker.body.token as string;

    const claim = await request(app.server).post(`/api/jobs/${jobId}/claim`).set('Authorization', `Bearer ${token}`).send();
    expect(claim.status).toBe(200);

    // Make it stale after claim.
    await pool.query('UPDATE jobs SET created_at = $2 WHERE id = $1', [jobId, new Date(Date.now() - 120_000)]);

    const artifact = { kind: 'screenshot', label: 'shot', sha256: 'abcd1234', url: 'https://example.com/shot.png' };
    const manifest = {
      manifestVersion: '1.0',
      jobId,
      bountyId: bountyResp.body.id,
      finalUrl: 'https://example.com/end',
      worker: { workerId: worker.body.workerId, skillVersion: '1.0.0', fingerprint: { fingerprintClass: 'desktop_us' } },
      result: {
        outcome: 'failure',
        failureType: 'other',
        severity: 'low',
        expected: 'Fresh results',
        observed: 'Stale results',
        reproConfidence: 'high',
      },
      reproSteps: ['fetch', 'produce artifacts'],
      artifacts: [artifact],
    };

    const submit = await request(app.server)
      .post(`/api/jobs/${jobId}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', `idem_stale_${Date.now()}`)
      .send({ manifest, artifactIndex: [artifact] });
    expect(submit.status).toBe(409);
    expect(submit.body.error.code).toBe('stale_job');
  });

  it('supports capability_tags subset matching for universal workers (capability_tags query param)', async () => {
    const app = buildServer();
    await app.ready();

    const keyResp = await request(app.server).post('/api/org/api-keys').send({ email: 'buyer@example.com', password: 'password', name: 'ci' });
    const buyerToken = keyResp.body.token;

    // Register the task type in the app registry so the bounty can be created.
    const regApp = await request(app.server)
      .post('/api/org/apps')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ slug: `clips-${Date.now()}`, taskType: 'clips', name: 'Clips' });
    expect(regApp.status).toBe(200);

    const bountyResp = await request(app.server)
      .post('/api/bounties')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({
        title: 'FFmpeg bounty',
        description: 'requires ffmpeg',
        allowedOrigins: ['https://example.com'],
        payoutCents: 5000,
        requiredProofs: 1,
        fingerprintClassesRequired: ['desktop_us'],
        taskDescriptor: { schema_version: 'v1', type: 'clips', capability_tags: ['ffmpeg'], input_spec: {}, output_spec: {} },
      });
    expect(bountyResp.status).toBe(200);
    await request(app.server).post(`/api/bounties/${bountyResp.body.id}/publish`).set('Authorization', `Bearer ${buyerToken}`).send();

    // Keep only the ffmpeg-tagged job.
    await pool.query('DELETE FROM jobs WHERE bounty_id <> $1', [bountyResp.body.id]);

    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'cap', capabilities: { browser: true } });
    const token = reg.body.token;

    const noMatch = await request(app.server)
      .get('/api/jobs/next')
      .query({ capability_tags: 'browser,http' })
      .set('Authorization', `Bearer ${token}`);
    expect(noMatch.status).toBe(200);
    expect(noMatch.body.state).toBe('idle');

    const match = await request(app.server)
      .get('/api/jobs/next')
      .query({ capability_tags: 'browser,http,ffmpeg' })
      .set('Authorization', `Bearer ${token}`);
    expect(match.status).toBe(200);
    expect(match.body.state).toBe('claimable');
    expect(match.body.data.job.taskDescriptor.capability_tags).toContain('ffmpeg');
  });

  it('supports task_type filter for universal workers (task_type query param)', async () => {
    const app = buildServer();
    await app.ready();

    const keyResp = await request(app.server).post('/api/org/api-keys').send({ email: 'buyer@example.com', password: 'password', name: 'ci' });
    const buyerToken = keyResp.body.token;

    // Register task types in the app registry so bounties can be created.
    const regA = await request(app.server)
      .post('/api/org/apps')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ slug: `type-a-${Date.now()}`, taskType: 'type_a', name: 'Type A' });
    expect(regA.status).toBe(200);
    const regB = await request(app.server)
      .post('/api/org/apps')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ slug: `type-b-${Date.now()}`, taskType: 'type_b', name: 'Type B' });
    expect(regB.status).toBe(200);

    const bountyA = await request(app.server)
      .post('/api/bounties')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({
        title: 'Type A bounty',
        description: 'type filter A',
        allowedOrigins: ['https://example.com'],
        payoutCents: 1000,
        requiredProofs: 1,
        fingerprintClassesRequired: ['desktop_us'],
        taskDescriptor: { schema_version: 'v1', type: 'type_a', capability_tags: ['http'], input_spec: {}, output_spec: {} },
      });
    expect(bountyA.status).toBe(200);
    await request(app.server).post(`/api/bounties/${bountyA.body.id}/publish`).set('Authorization', `Bearer ${buyerToken}`).send();

    const bountyB = await request(app.server)
      .post('/api/bounties')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({
        title: 'Type B bounty',
        description: 'type filter B',
        allowedOrigins: ['https://example.com'],
        payoutCents: 1000,
        requiredProofs: 1,
        fingerprintClassesRequired: ['desktop_us'],
        taskDescriptor: { schema_version: 'v1', type: 'type_b', capability_tags: ['http'], input_spec: {}, output_spec: {} },
      });
    expect(bountyB.status).toBe(200);
    await request(app.server).post(`/api/bounties/${bountyB.body.id}/publish`).set('Authorization', `Bearer ${buyerToken}`).send();

    // Keep only these two bounties' jobs.
    await pool.query('DELETE FROM jobs WHERE bounty_id NOT IN ($1, $2)', [bountyA.body.id, bountyB.body.id]);

    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'type_filter', capabilities: { browser: true } });
    const token = reg.body.token;

    const nextA = await request(app.server)
      .get('/api/jobs/next')
      .query({ task_type: 'type_a', capability_tag: 'http' })
      .set('Authorization', `Bearer ${token}`);
    expect(nextA.status).toBe(200);
    expect(nextA.body.state).toBe('claimable');
    expect(nextA.body.data.job.taskDescriptor.type).toBe('type_a');

    const nextB = await request(app.server)
      .get('/api/jobs/next')
      .query({ task_type: 'type_b', capability_tag: 'http' })
      .set('Authorization', `Bearer ${token}`);
    expect(nextB.status).toBe(200);
    expect(nextB.body.state).toBe('claimable');
    expect(nextB.body.data.job.taskDescriptor.type).toBe('type_b');
  });
});

describe('Buyer bounty lifecycle', () => {
  beforeEach(async () => {
    await resetStore();
  });

  it('creates and publishes bounty, generates jobs', async () => {
    const app = buildServer();
    await app.ready();
    // login buyer
    const login = await request(app.server).post('/api/auth/login').send({ email: 'buyer@example.com', password: 'password' });
    expect(login.status).toBe(200);
    const { orgId } = login.body;

    // create API key
    const keyResp = await request(app.server).post('/api/org/api-keys').send({ email: 'buyer@example.com', password: 'password', name: 'ci' });
    expect(keyResp.status).toBe(200);
    const buyerToken = keyResp.body.token;

    // create bounty
    const bountyResp = await request(app.server)
      .post('/api/bounties')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({
        title: 'New bounty',
        description: 'Test flow',
        allowedOrigins: ['https://example.com'],
        payoutCents: 1200,
        requiredProofs: 1,
        fingerprintClassesRequired: ['desktop_us'],
      });
    expect(bountyResp.status).toBe(200);
    const bountyId = bountyResp.body.id;

    // publish
    const pub = await request(app.server)
      .post(`/api/bounties/${bountyId}/publish`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send();
    expect(pub.status).toBe(200);
    expect(pub.body.status).toBe('published');

    // list jobs
    const jobs = await request(app.server)
      .get(`/api/bounties/${bountyId}/jobs`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send();
    expect(jobs.status).toBe(200);
    expect(jobs.body.jobs.length).toBe(1);
  });

  it('validates task_descriptor and exposes it to workers', async () => {
    const app = buildServer();
    await app.ready();
    const login = await request(app.server).post('/api/auth/login').send({ email: 'buyer@example.com', password: 'password' });
    const keyResp = await request(app.server).post('/api/org/api-keys').send({ email: 'buyer@example.com', password: 'password', name: 'ci' });
    const buyerToken = keyResp.body.token;

    const descriptor = {
      type: 'clips_highlights',
      capability_tags: ['ffmpeg', 'llm_summarize'],
      input_spec: { vod_url: 'https://example.com/test.mp4' },
      output_spec: { mp4: true },
      freshness_sla_sec: 3600,
    };

    const bountyResp = await request(app.server)
      .post('/api/bounties')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({
        title: 'Clips bounty',
        description: 'Clip a VOD',
        allowedOrigins: ['https://example.com'],
        payoutCents: 1500,
        requiredProofs: 1,
        fingerprintClassesRequired: ['desktop_us'],
        taskDescriptor: descriptor,
      });
    expect(bountyResp.status).toBe(200);

    await request(app.server).post(`/api/bounties/${bountyResp.body.id}/publish`).set('Authorization', `Bearer ${buyerToken}`).send();

    const worker = await request(app.server).post('/api/workers/register').send({ displayName: 'W', capabilities: { browser: true } });
    const token = worker.body.token;
    const next = await request(app.server)
      .get('/api/jobs/next')
      .query({ capability_tag: 'ffmpeg' })
      .set('Authorization', `Bearer ${token}`);
    expect(next.status).toBe(200);
    expect(next.body.data.job.taskDescriptor.capability_tags).toContain('ffmpeg');
  });

  it('rejects task_descriptor with sensitive keys', async () => {
    const app = buildServer();
    await app.ready();
    const keyResp = await request(app.server).post('/api/org/api-keys').send({ email: 'buyer@example.com', password: 'password', name: 'ci' });
    const buyerToken = keyResp.body.token;

    const bountyResp = await request(app.server)
      .post('/api/bounties')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({
        title: 'Sensitive bounty',
        description: 'Should fail',
        allowedOrigins: ['https://example.com'],
        payoutCents: 1200,
        requiredProofs: 1,
        fingerprintClassesRequired: ['desktop_us'],
        taskDescriptor: {
          schema_version: 'v1',
          type: 'sensitive',
          capability_tags: ['http'],
          input_spec: { api_token: 'shh' },
          output_spec: {},
        },
      });
    expect(bountyResp.status).toBe(400);
    expect(bountyResp.body.error.code).toBe('task_descriptor_sensitive');
  });

  it('enforces MIN_PAYOUT_CENTS floor on bounty creation (anti-micropayout thrash)', async () => {
    process.env.MIN_PAYOUT_CENTS = '2000';
    try {
      const app = buildServer();
      await app.ready();
      const keyResp = await request(app.server).post('/api/org/api-keys').send({ email: 'buyer@example.com', password: 'password', name: 'ci' });
      const buyerToken = keyResp.body.token;

      const bountyResp = await request(app.server)
        .post('/api/bounties')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          title: 'Too small',
          description: 'should fail',
          allowedOrigins: ['https://example.com'],
          payoutCents: 1200,
          requiredProofs: 1,
          fingerprintClassesRequired: ['desktop_us'],
        });
      expect(bountyResp.status).toBe(400);
      expect(bountyResp.body.error.code).toBe('min_payout');
    } finally {
      delete process.env.MIN_PAYOUT_CENTS;
    }
  });

  it('can disable task_descriptor intake/exposure via ENABLE_TASK_DESCRIPTOR', async () => {
    process.env.ENABLE_TASK_DESCRIPTOR = 'false';
    try {
      const app = buildServer();
      await app.ready();

      const keyResp = await request(app.server).post('/api/org/api-keys').send({ email: 'buyer@example.com', password: 'password', name: 'ci' });
      const buyerToken = keyResp.body.token;

      const withDesc = await request(app.server)
        .post('/api/bounties')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          title: 'Desc bounty',
          description: 'should fail when disabled',
          allowedOrigins: ['https://example.com'],
          payoutCents: 1200,
          requiredProofs: 1,
          fingerprintClassesRequired: ['desktop_us'],
          taskDescriptor: { schema_version: 'v1', type: 'x', capability_tags: ['http'], input_spec: {}, output_spec: {} },
        });
      expect(withDesc.status).toBe(409);
      expect(withDesc.body.error.code).toBe('feature_disabled');

      const noDesc = await request(app.server)
        .post('/api/bounties')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          title: 'Legacy bounty',
          description: 'no descriptor',
          allowedOrigins: ['https://example.com'],
          payoutCents: 1200,
          requiredProofs: 1,
          fingerprintClassesRequired: ['desktop_us'],
        });
      expect(noDesc.status).toBe(200);
      await request(app.server).post(`/api/bounties/${noDesc.body.id}/publish`).set('Authorization', `Bearer ${buyerToken}`).send();

      const worker = await request(app.server).post('/api/workers/register').send({ displayName: 'W2', capabilities: { browser: true } });
      const token = worker.body.token;
      const next = await request(app.server).get('/api/jobs/next').query({ capability_tag: 'http' }).set('Authorization', `Bearer ${token}`);
      expect(next.status).toBe(200);
      expect(next.body.data.job.taskDescriptor).toBeFalsy();
    } finally {
      delete process.env.ENABLE_TASK_DESCRIPTOR;
    }
  });
});

describe('Admin controls', () => {
  const ADMIN_TOKEN = 'pw_adm_internal';
  beforeEach(async () => {
    await resetStore();
  });

  it('can ban a worker and block claims', async () => {
    const app = buildServer();
    await app.ready();
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'banme', capabilities: { browser: true } });
    const workerId = reg.body.workerId;
    const token = reg.body.token;

    const ban = await request(app.server)
      .post(`/api/admin/workers/${workerId}/ban`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send();
    expect(ban.status).toBe(200);

    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${token}`);
    expect(next.status).toBe(401);
  });

  it('respects UNIVERSAL_WORKER_PAUSE', async () => {
    process.env.UNIVERSAL_WORKER_PAUSE = 'true';
    const app = buildServer();
    await app.ready();
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'paused', capabilities: { browser: true } });
    const token = reg.body.token;
    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${token}`);
    expect(next.status).toBe(200);
    expect(next.body.state).toBe('idle');
    delete process.env.UNIVERSAL_WORKER_PAUSE;
  });

  it('auto-pauses worker intake when outbox pending age exceeds MAX_OUTBOX_PENDING_AGE_SEC', async () => {
    process.env.MAX_OUTBOX_PENDING_AGE_SEC = '1';
    try {
      const app = buildServer();
      await app.ready();

      // Insert a deliberately old pending outbox event to simulate lag.
      await pool.query(
        `
        INSERT INTO outbox_events(id, topic, idempotency_key, payload, status, attempts, available_at, locked_at, locked_by, last_error, created_at, sent_at)
        VALUES ($1, $2, $3, $4::jsonb, 'pending', 0, $5, NULL, NULL, NULL, $6, NULL)
        `,
        [
          'evt_old',
          'verification.requested',
          'idem_old',
          JSON.stringify({ hello: 'world' }),
          new Date(Date.now() - 120_000),
          new Date(Date.now() - 120_000),
        ]
      );

      const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'lag', capabilities: { browser: true } });
      const token = reg.body.token;
      const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${token}`);
      expect(next.status).toBe(200);
      expect(next.body.state).toBe('idle');
      expect(String(next.body.next_steps?.[0] ?? '')).toContain('Outbox queue lag high');
    } finally {
      delete process.env.MAX_OUTBOX_PENDING_AGE_SEC;
    }
  });

  it('exposes app summary metrics', async () => {
    const app = buildServer();
    await app.ready();
    // Create a bounty with a task descriptor type.
    const keyResp = await request(app.server).post('/api/org/api-keys').send({ email: 'buyer@example.com', password: 'password', name: 'ci' });
    const buyerToken = keyResp.body.token;
    const bounty = await request(app.server)
      .post('/api/bounties')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({
        title: 'Metrics bounty',
        description: 'metrics',
        allowedOrigins: ['https://example.com'],
        payoutCents: 1200,
        requiredProofs: 1,
        fingerprintClassesRequired: ['desktop_us'],
        taskDescriptor: { schema_version: 'v1', type: 'github_scan', capability_tags: ['http'], input_spec: {}, output_spec: {} },
      });
    await request(app.server).post(`/api/bounties/${bounty.body.id}/publish`).set('Authorization', `Bearer ${buyerToken}`).send();

    const res = await request(app.server).get('/api/admin/apps/summary').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    const entry = (res.body.apps ?? []).find((a: any) => a.taskType === 'github_scan');
    expect(entry).toBeTruthy();
    expect(entry.jobsTotal).toBeGreaterThan(0);
  });

  it('lists alarm notifications (empty list ok)', async () => {
    const app = buildServer();
    await app.ready();
    const ADMIN_TOKEN = 'pw_adm_internal';

    const res = await request(app.server).get('/api/admin/alerts?limit=5').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.alerts)).toBe(true);
    expect(typeof res.body.total).toBe('number');
  });

  it('can requeue verification and payout is auto-paid via outbox processor', async () => {
    const app = buildServer();
    await app.ready();
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'w', capabilities: { browser: true } });
    const token = reg.body.token;
    const job = (await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${token}`)).body.data.job;
    await request(app.server).post(`/api/jobs/${job.jobId}/claim`).set('Authorization', `Bearer ${token}`);
    const artifact = { kind: 'screenshot', label: 'f', sha256: 'abcd1234', url: 'https://cdn.local/f.png' };
    const manifest = {
      manifestVersion: '1.0',
      jobId: job.jobId,
      bountyId: job.bountyId,
      worker: {
        workerId: reg.body.workerId,
        skillVersion: '1.0.0',
        fingerprint: { fingerprintClass: job.environment.fingerprintClass },
      },
      result: {
        outcome: 'failure',
        failureType: 'blocker',
        severity: 'high',
        expected: 'ok',
        observed: 'bad',
        reproConfidence: 'high',
      },
      reproSteps: ['a'],
      artifacts: [artifact],
    };

    const submit = await request(app.server)
      .post(`/api/jobs/${job.jobId}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ manifest, artifactIndex: [artifact] });
    const submissionId = submit.body.data.submission.id;

    const verClaim = await request(app.server)
      .post('/api/verifier/claim')
      .set('Authorization', `Bearer ${VERIFIER_TOKEN}`)
      .send({ submissionId, attemptNo: 1, messageId: 'm', idempotencyKey: 'idem', verifierInstanceId: 'v1', claimTtlSec: 600 });
    const claimToken = verClaim.body.claimToken;

    await request(app.server)
      .post('/api/verifier/verdict')
      .set('Authorization', `Bearer ${VERIFIER_TOKEN}`)
      .send({
        verificationId: verClaim.body.verificationId,
        claimToken,
        submissionId,
        jobId: job.jobId,
        attemptNo: 1,
        verdict: 'pass',
        reason: 'ok',
        scorecard: { R: 1, E: 1, A: 1, N: 1, T: 1, qualityScore: 100 },
        evidenceArtifacts: [artifact],
      });

    // process outbox payouts (like the payout worker would)
    const { listOutbox, markOutboxSent } = await import('../src/store.js');
    const { handlePayoutRequested } = await import('../workers/handlers.js');
    const items = await listOutbox('payout.requested');
    for (const item of items) {
      await handlePayoutRequested(item.payload);
      await markOutboxSent(item.id);
    }

    // check payout marked paid
    const payouts = await listPayouts();
    expect(payouts.some((p) => p.status === 'paid')).toBe(true);
  });
});

describe('Duplicate suppression', () => {
  beforeEach(async () => {
    await resetStore();
  });
  const ADMIN_TOKEN = 'pw_adm_internal';
  it('rejects second submission after first pass with same dedupe key', async () => {
    const app = buildServer();
    await app.ready();
    // worker 1
    const w1 = await request(app.server).post('/api/workers/register').send({ displayName: 'w1', capabilities: { browser: true } });
    const t1 = w1.body.token;
    const job1 = (await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${t1}`)).body.data.job;
    await request(app.server).post(`/api/jobs/${job1.jobId}/claim`).set('Authorization', `Bearer ${t1}`);
    const artifact = { kind: 'screenshot', label: 'f', sha256: 'abcd1234', url: 'https://cdn.local/f.png' };
    const manifest = {
      manifestVersion: '1.0', jobId: job1.jobId, bountyId: job1.bountyId,
      worker: { workerId: w1.body.workerId, skillVersion: '1.0.0', fingerprint: { fingerprintClass: job1.environment.fingerprintClass } },
      result: { outcome: 'failure', failureType: 'blocker', severity: 'high', expected: 'ok', observed: 'SAME_OBS', reproConfidence: 'high' },
      reproSteps: ['a'], artifacts: [artifact]
    };
    const submit1 = await request(app.server).post(`/api/jobs/${job1.jobId}/submit`).set('Authorization', `Bearer ${t1}`).send({ manifest, artifactIndex: [artifact] });
    const verClaim = await request(app.server).post('/api/verifier/claim').set('Authorization', 'Bearer pw_vf_internal')
      .send({ submissionId: submit1.body.data.submission.id, attemptNo: 1, messageId: 'm', idempotencyKey: 'idem', verifierInstanceId: 'v1', claimTtlSec: 600 });
    await request(app.server).post('/api/verifier/verdict').set('Authorization', 'Bearer pw_vf_internal')
      .send({ verificationId: verClaim.body.verificationId, claimToken: verClaim.body.claimToken, submissionId: submit1.body.data.submission.id, jobId: job1.jobId, attemptNo: 1, verdict: 'pass', reason: 'ok', scorecard: { R:1,E:1,A:1,N:1,T:1,qualityScore:100 }, evidenceArtifacts:[artifact] });

    // worker 2
    const w2 = await request(app.server).post('/api/workers/register').send({ displayName: 'w2', capabilities: { browser: true } });
    const t2 = w2.body.token;
    const job2 = (await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${t2}`)).body.data.job;
    await request(app.server).post(`/api/jobs/${job2.jobId}/claim`).set('Authorization', `Bearer ${t2}`);
    const manifest2 = { ...manifest, jobId: job2.jobId, worker: { workerId: w2.body.workerId, skillVersion: '1.0.0', fingerprint: { fingerprintClass: job2.environment.fingerprintClass } } };
    const submit2 = await request(app.server).post(`/api/jobs/${job2.jobId}/submit`).set('Authorization', `Bearer ${t2}`).send({ manifest: manifest2, artifactIndex: [artifact] });
    expect(submit2.body.state).toBe('done');
    expect(submit2.body.data.submission.status).toBe('duplicate');
  });
});

describe('Rate limiting', () => {
  beforeEach(async () => {
    await resetStore();
  });
  it('rate limits worker on rapid requests', async () => {
    const app = buildServer();
    await app.ready();
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'rl', capabilities: { browser: true } });
    const token = reg.body.token;
    // Flood >120 in theory; we'll simulate with loop until first 429
    let got429 = false;
    for (let i = 0; i < 200; i++) {
      const res = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${token}`);
      if (res.status === 429) { got429 = true; break; }
    }
    expect(got429).toBe(true);
  });
});

describe('Upload presign policy', () => {
  beforeEach(async () => {
    await resetStore();
  });

  it('rejects disallowed MIME types', async () => {
    const app = buildServer();
    await app.ready();
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'u', capabilities: { browser: true } });
    const token = reg.body.token;
    const job = (await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${token}`)).body.data.job;
    await request(app.server).post(`/api/jobs/${job.jobId}/claim`).set('Authorization', `Bearer ${token}`);

    const res = await request(app.server)
      .post('/api/uploads/presign')
      .set('Authorization', `Bearer ${token}`)
      .send({ jobId: job.jobId, files: [{ filename: 'evil.exe', contentType: 'application/x-msdownload', sizeBytes: 123 }] });
    expect(res.status).toBe(400);
  });

  it('rejects oversized files when sizeBytes provided', async () => {
    const app = buildServer();
    await app.ready();
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'u', capabilities: { browser: true } });
    const token = reg.body.token;
    const job = (await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${token}`)).body.data.job;
    await request(app.server).post(`/api/jobs/${job.jobId}/claim`).set('Authorization', `Bearer ${token}`);

    const res = await request(app.server)
      .post('/api/uploads/presign')
      .set('Authorization', `Bearer ${token}`)
      .send({ jobId: job.jobId, files: [{ filename: 'big.png', contentType: 'image/png', sizeBytes: 999_999_999 }] });
    expect(res.status).toBe(400);
  });
});

describe('Security: origin enforcement', () => {
  beforeEach(async () => {
    await resetStore();
  });

  it('rejects origin escape attempts in finalUrl', async () => {
    const app = buildServer();
    await app.ready();

    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'o', capabilities: { browser: true } });
    const token = reg.body.token as string;
    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${token}`);
    const job = next.body.data.job;
    await request(app.server).post(`/api/jobs/${job.jobId}/claim`).set('Authorization', `Bearer ${token}`);

    const presign = await request(app.server)
      .post('/api/uploads/presign')
      .set('Authorization', `Bearer ${token}`)
      .send({ jobId: job.jobId, files: [{ filename: 'shot.png', contentType: 'image/png' }] });
    const artifact = { kind: 'screenshot', label: 'f', sha256: 'abcd1234', url: presign.body.uploads[0].finalUrl };

    const manifest = {
      manifestVersion: '1.0',
      jobId: job.jobId,
      bountyId: job.bountyId,
      finalUrl: 'https://example.com.evil/end',
      worker: { workerId: reg.body.workerId, skillVersion: '1.0.0', fingerprint: { fingerprintClass: job.environment.fingerprintClass } },
      result: { outcome: 'failure', failureType: 'blocker', severity: 'high', expected: 'ok', observed: 'bad', reproConfidence: 'high' },
      reproSteps: ['a'],
      artifacts: [artifact],
    };

    const submit = await request(app.server)
      .post(`/api/jobs/${job.jobId}/submit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ manifest, artifactIndex: [artifact] });

    expect(submit.status).toBe(400);
    expect(submit.body.error?.code).toBe('origin_violation');
  });
});

describe('Metrics', () => {
  beforeEach(async () => {
    await resetStore();
  });

  it('exposes Prometheus metrics', async () => {
    const app = buildServer();
    await app.ready();
    const res = await request(app.server).get('/health/metrics').send();
    expect(res.status).toBe(200);
    expect(String(res.text)).toContain('proofwork_requests_total');
    expect(String(res.text)).toContain('proofwork_verifier_backlog');
  });
});

describe('Worker payout address', () => {
  beforeEach(async () => {
    await resetStore();
  });

  it('accepts a valid Base payout address signature', async () => {
    const app = buildServer();
    await app.ready();

    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'payout', capabilities: { browser: true } });
    const token = reg.body.token as string;
    const workerId = reg.body.workerId as string;

    const wallet = Wallet.createRandom();
    const addr = getAddress(wallet.address);
    const message = `Proofwork payout address verification\nworkerId=${workerId}\nchain=base\naddress=${addr}`;
    const signature = await wallet.signMessage(message);

    const res = await request(app.server)
      .post('/api/worker/payout-address')
      .set('Authorization', `Bearer ${token}`)
      .send({ chain: 'base', address: addr, signature });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const row = await pool.query('SELECT payout_chain, payout_address FROM workers WHERE id = $1', [workerId]);
    expect(row.rows[0].payout_chain).toBe('base');
    expect(row.rows[0].payout_address).toBe(addr);
  });
});

describe('Lease reaper', () => {
  beforeEach(async () => {
    await resetStore();
  });
  it('expires a claimed job after TTL', async () => {
    const app = buildServer();
    await app.ready();
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'r', capabilities: { browser: true } });
    const token = reg.body.token;
    const job = (await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${token}`)).body.data.job;
    await request(app.server).post(`/api/jobs/${job.jobId}/claim`).set('Authorization', `Bearer ${token}`);
    // simulate expiry
    const j = await getJob(job.jobId);
    expect(j).toBeTruthy();
    if (j) {
      // Ensure expiry is unambiguous even if system time jitter causes Date.now() granularity issues.
      j.leaseExpiresAt = Date.now() - 60_000;
      await updateJob(j);
    }
    const reap = await request(app.server).post('/api/internal/reap-leases').send();
    expect(reap.body.expired.includes(job.jobId)).toBe(true);
  });
});
