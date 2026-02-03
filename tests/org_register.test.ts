import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { buildServer } from '../src/server.js';
import { resetStore } from '../src/store.js';
import { db } from '../src/db/client.js';

describe('org registration', () => {
  beforeEach(async () => {
    await resetStore();
  });

  it('registers a new org + owner user, supports api-key login, and can publish after top-up', async () => {
    const app = buildServer();
    await app.ready();

    const email = `test+${Date.now()}@example.com`;
    const password = 'password123';

    const reg = await request(app.server).post('/api/org/register').send({ orgName: 'Test Org', email, password, apiKeyName: 'default' });
    expect(reg.status).toBe(200);
    expect(reg.body.orgId).toMatch(/^org_/);
    expect(reg.body.token).toMatch(/^pw_bu_/);

    const row = await db.selectFrom('org_users').select(['password_hash']).where('email', '=', email.toLowerCase()).executeTakeFirst();
    expect(String(row?.password_hash ?? '')).toMatch(/^scrypt\$/);

    // Verify the password works for creating additional API keys.
    const apiKeyResp = await request(app.server).post('/api/org/api-keys').send({ email, password, name: 'ci' });
    expect(apiKeyResp.status).toBe(200);
    const buyerToken = String(apiKeyResp.body.token ?? '');
    expect(buyerToken).toMatch(/^pw_bu_/);

    // Add + verify an origin so bounty creation can succeed.
    const addOrigin = await request(app.server)
      .post('/api/origins')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ origin: 'https://example.com', method: 'dns_txt' });
    expect(addOrigin.status).toBe(200);
    const originId = String(addOrigin.body?.origin?.id ?? '');
    expect(originId).toBeTruthy();

    const checkOrigin = await request(app.server).post(`/api/origins/${encodeURIComponent(originId)}/check`).set('Authorization', `Bearer ${buyerToken}`);
    expect(checkOrigin.status).toBe(200);
    expect(checkOrigin.body?.origin?.status).toBe('verified');

    // Create bounty and verify publish is blocked until budget is funded.
    const bounty = await request(app.server)
      .post('/api/bounties')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({
        title: 'B',
        description: 'D',
        allowedOrigins: ['https://example.com'],
        requiredProofs: 1,
        fingerprintClassesRequired: ['desktop_us'],
        payoutCents: 1500,
      });
    expect(bounty.status).toBe(200);
    const bountyId = String(bounty.body?.id ?? '');
    expect(bountyId).toBeTruthy();

    const pubFail = await request(app.server).post(`/api/bounties/${encodeURIComponent(bountyId)}/publish`).set('Authorization', `Bearer ${buyerToken}`);
    expect(pubFail.status).toBe(409);
    expect(pubFail.body?.error?.code).toBe('insufficient_funds');

    const adminToken = process.env.ADMIN_TOKEN || 'pw_adm_internal';
    const topup = await request(app.server)
      .post(`/api/admin/billing/orgs/${encodeURIComponent(String(reg.body.orgId))}/topup`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amountCents: 5000 });
    expect(topup.status).toBe(200);

    const pub = await request(app.server).post(`/api/bounties/${encodeURIComponent(bountyId)}/publish`).set('Authorization', `Bearer ${buyerToken}`);
    expect(pub.status).toBe(200);
  });

  it('rejects duplicate registration by email', async () => {
    const app = buildServer();
    await app.ready();

    const email = `dup+${Date.now()}@example.com`;
    const password = 'password123';

    const r1 = await request(app.server).post('/api/org/register').send({ orgName: 'Dup Org', email, password });
    expect(r1.status).toBe(200);

    const r2 = await request(app.server).post('/api/org/register').send({ orgName: 'Dup Org 2', email, password });
    expect(r2.status).toBe(409);
  });
});

