import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import http from 'http';
import { buildServer } from '../src/server.js';
import { resetStore } from '../src/store.js';

describe('org quotas', () => {
  beforeEach(async () => {
    await resetStore();
  });

  it('enforces daily/monthly spend limits and max_open_jobs on publish', async () => {
    const app = buildServer();
    await app.ready();

    let verifyToken = '';
    const originServer = http.createServer((req, res) => {
      if (req.url === '/.well-known/proofwork-verify.txt') {
        if (!verifyToken) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('missing');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(verifyToken);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (originServer.address() as any).port as number;
    const originUrl = `http://127.0.0.1:${port}`;

    const email = `quota+${Date.now()}@example.com`;
    const password = 'password123';

    try {
      const reg = await request(app.server).post('/api/org/register').send({ orgName: 'Quota Org', email, password, apiKeyName: 'default' });
      expect(reg.status).toBe(200);
      const orgId = String(reg.body.orgId);

      const apiKeyResp = await request(app.server).post('/api/org/api-keys').send({ email, password, name: 'ci' });
      expect(apiKeyResp.status).toBe(200);
      const buyerToken = String(apiKeyResp.body.token ?? '');
      expect(buyerToken).toMatch(/^pw_bu_/);

      // Verify an origin.
      const addOrigin = await request(app.server)
        .post('/api/origins')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({ origin: originUrl, method: 'http_file' });
      expect(addOrigin.status).toBe(200);
      const originId = String(addOrigin.body?.origin?.id ?? '');
      verifyToken = String(addOrigin.body?.origin?.token ?? '');
      expect(verifyToken).toMatch(/^pw_verify_/);

      const checkOrigin = await request(app.server).post(`/api/origins/${encodeURIComponent(originId)}/check`).set('Authorization', `Bearer ${buyerToken}`);
      expect(checkOrigin.status).toBe(200);
      expect(checkOrigin.body?.origin?.status).toBe('verified');

      // Fund the org so publish can proceed.
      const adminToken = process.env.ADMIN_TOKEN || 'pw_adm_internal';
      const topup = await request(app.server)
        .post(`/api/admin/billing/orgs/${encodeURIComponent(orgId)}/topup`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ amountCents: 50_000 });
      expect(topup.status).toBe(200);

      // Set a small daily spend limit.
      const setDaily = await request(app.server)
        .put('/api/org/quotas')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({ dailySpendLimitCents: 1000, monthlySpendLimitCents: null, maxOpenJobs: null });
      expect(setDaily.status).toBe(200);

      // Create bounty with payout=1500 -> reserve=1500 => exceeds daily limit.
      const bounty = await request(app.server)
        .post('/api/bounties')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          title: 'B',
          description: 'D',
          allowedOrigins: [originUrl],
          requiredProofs: 1,
          fingerprintClassesRequired: ['desktop_us'],
          payoutCents: 1500,
        });
      expect(bounty.status).toBe(200);
      const bountyId = String(bounty.body?.id ?? '');

      const pubFail = await request(app.server).post(`/api/bounties/${encodeURIComponent(bountyId)}/publish`).set('Authorization', `Bearer ${buyerToken}`);
      expect(pubFail.status).toBe(409);
      expect(pubFail.body?.error?.code).toBe('daily_spend_limit_exceeded');

      // Raise limits and publish.
      const setOk = await request(app.server)
        .put('/api/org/quotas')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({ dailySpendLimitCents: 10_000, monthlySpendLimitCents: 10_000, maxOpenJobs: null });
      expect(setOk.status).toBe(200);

      const pubOk = await request(app.server).post(`/api/bounties/${encodeURIComponent(bountyId)}/publish`).set('Authorization', `Bearer ${buyerToken}`);
      expect(pubOk.status).toBe(200);

      // Now enforce maxOpenJobs: 1 open job allowed, but this bounty would create 2.
      const setMax = await request(app.server)
        .put('/api/org/quotas')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({ dailySpendLimitCents: null, monthlySpendLimitCents: null, maxOpenJobs: 1 });
      expect(setMax.status).toBe(200);

      const bounty2 = await request(app.server)
        .post('/api/bounties')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          title: 'B2',
          description: 'D2',
          allowedOrigins: [originUrl],
          requiredProofs: 1,
          fingerprintClassesRequired: ['desktop_us', 'mobile_us'],
          payoutCents: 1000,
        });
      expect(bounty2.status).toBe(200);
      const bountyId2 = String(bounty2.body?.id ?? '');

      const pubFail2 = await request(app.server).post(`/api/bounties/${encodeURIComponent(bountyId2)}/publish`).set('Authorization', `Bearer ${buyerToken}`);
      expect(pubFail2.status).toBe(409);
      expect(pubFail2.body?.error?.code).toBe('max_open_jobs_exceeded');
    } finally {
      await new Promise<void>((resolve) => originServer.close(() => resolve()));
      await app.close();
    }
  });
});

