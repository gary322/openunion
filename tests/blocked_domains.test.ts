import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import http from 'http';
import { buildServer } from '../src/server.js';
import { resetStore } from '../src/store.js';

describe('blocked domains governance', () => {
  beforeEach(async () => {
    await resetStore();
  });

  it('blocks origin creation and bounty creation when a domain is blocked', async () => {
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

    try {
      const email = `blocked+${Date.now()}@example.com`;
      const password = 'password123';
      const reg = await request(app.server).post('/api/org/register').send({ orgName: 'Blocked Org', email, password, apiKeyName: 'default' });
      expect(reg.status).toBe(200);

      const key = await request(app.server).post('/api/org/api-keys').send({ email, password, name: 'ci' });
      expect(key.status).toBe(200);
      const buyerToken = String(key.body.token);

      // Verify an origin (127.0.0.1:<port>).
      const addOrigin = await request(app.server)
        .post('/api/origins')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({ origin: originUrl, method: 'http_file' });
      expect(addOrigin.status).toBe(200);
      const originId = String(addOrigin.body?.origin?.id ?? '');
      verifyToken = String(addOrigin.body?.origin?.token ?? '');
      const check = await request(app.server).post(`/api/origins/${encodeURIComponent(originId)}/check`).set('Authorization', `Bearer ${buyerToken}`);
      expect(check.status).toBe(200);
      expect(check.body?.origin?.status).toBe('verified');

      // Block the domain.
      const adminToken = process.env.ADMIN_TOKEN || 'pw_adm_internal';
      const block = await request(app.server)
        .post('/api/admin/blocked-domains')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ domain: '127.0.0.1', reason: 'test' });
      expect(block.status).toBe(200);

      // Now bounty creation should be blocked even though origin is verified.
      const bounty = await request(app.server)
        .post('/api/bounties')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          title: 'B',
          description: 'D',
          allowedOrigins: [originUrl],
          requiredProofs: 1,
          fingerprintClassesRequired: ['desktop_us'],
          payoutCents: 1000,
        });
      expect(bounty.status).toBe(403);
      expect(bounty.body?.error?.code).toBe('blocked_domain');

      // Also blocks new origin adds for blocked domains.
      const block2 = await request(app.server)
        .post('/api/admin/blocked-domains')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ domain: 'example.com', reason: 'test' });
      expect(block2.status).toBe(200);

      const addBadOrigin = await request(app.server)
        .post('/api/origins')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({ origin: 'https://example.com', method: 'dns_txt' });
      expect(addBadOrigin.status).toBe(403);
      expect(addBadOrigin.body?.error?.code).toBe('blocked_domain');
    } finally {
      await new Promise<void>((resolve) => originServer.close(() => resolve()));
      await app.close();
    }
  });
});

