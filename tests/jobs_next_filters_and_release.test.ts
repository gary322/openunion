import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildServer } from '../src/server.js';
import { resetStore, getJob } from '../src/store.js';

describe('jobs/next filters + lease release', () => {
  let app: any;

  beforeEach(async () => {
    await resetStore();
    app = buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('supports exclude_job_ids on /api/jobs/next', async () => {
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { browser: true } });
    expect(reg.status).toBe(200);
    const token = reg.body.token as string;

    const first = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(first.body.state).toBe('claimable');
    const job1 = first.body.data.job;
    expect(job1?.jobId).toBeTruthy();

    const second = await request(app.server)
      .get(`/api/jobs/next?exclude_job_ids=${encodeURIComponent(String(job1.jobId))}`)
      .set('Authorization', `Bearer ${token}`);
    expect(second.status).toBe(200);
    expect(second.body.state).toBe('claimable');
    const job2 = second.body.data.job;
    expect(String(job2.jobId)).not.toBe(String(job1.jobId));
  });

  it('supports require_job_id on /api/jobs/next', async () => {
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { browser: true } });
    expect(reg.status).toBe(200);
    const token = reg.body.token as string;

    const first = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(first.body.state).toBe('claimable');
    const job1 = first.body.data.job;
    expect(job1?.jobId).toBeTruthy();

    const required = await request(app.server)
      .get('/api/jobs/next')
      .query({ require_job_id: String(job1.jobId) })
      .set('Authorization', `Bearer ${token}`);
    expect(required.status).toBe(200);
    expect(required.body.state).toBe('claimable');
    expect(String(required.body.data.job.jobId)).toBe(String(job1.jobId));
  });

  it('supports require_bounty_id on /api/jobs/next', async () => {
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { browser: true } });
    expect(reg.status).toBe(200);
    const token = reg.body.token as string;

    const first = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(first.body.state).toBe('claimable');
    const job1 = first.body.data.job;
    expect(job1?.bountyId).toBeTruthy();

    const required = await request(app.server)
      .get('/api/jobs/next')
      .query({ require_bounty_id: String(job1.bountyId) })
      .set('Authorization', `Bearer ${token}`);
    expect(required.status).toBe(200);
    expect(required.body.state).toBe('claimable');
    expect(String(required.body.data.job.bountyId)).toBe(String(job1.bountyId));
  });

  it('allows a worker to release a claimed lease early', async () => {
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { browser: true } });
    expect(reg.status).toBe(200);
    const token = reg.body.token as string;

    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${token}`);
    expect(next.status).toBe(200);
    expect(next.body.state).toBe('claimable');
    const job = next.body.data.job;

    const claim = await request(app.server)
      .post(`/api/jobs/${job.jobId}/claim`)
      .set('Authorization', `Bearer ${token}`)
      .send();
    expect(claim.status).toBe(200);
    const leaseNonce = String(claim.body.data.leaseNonce ?? '');
    expect(leaseNonce).toBeTruthy();

    const rel = await request(app.server)
      .post(`/api/jobs/${job.jobId}/release`)
      .set('Authorization', `Bearer ${token}`)
      .send({ leaseNonce, reason: 'unsafe descriptor' });
    expect(rel.status).toBe(200);
    expect(rel.body.ok).toBe(true);

    const row = await getJob(String(job.jobId));
    expect(row?.status).toBe('open');
    expect(row?.leaseWorkerId).toBeUndefined();
    expect(row?.leaseNonce).toBeUndefined();

    const next2 = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${token}`);
    expect(next2.status).toBe(200);
    expect(next2.body.state).toBe('claimable');
  });

  it('rate-limits /api/workers/register per ip', async () => {
    // rate is configured to 30/min; verify we get 429 past that point.
    let last = 0;
    for (let i = 0; i < 35; i++) {
      const r = await request(app.server).post('/api/workers/register').send({ displayName: `W${i}`, capabilities: { browser: true } });
      last = r.status;
      if (i < 30) expect(r.status).toBe(200);
    }
    expect(last).toBe(429);
  });
});
