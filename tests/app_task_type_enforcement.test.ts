import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import http from 'http';
import { buildServer } from '../src/server.js';
import { resetStore } from '../src/store.js';

describe('app task_type enforcement', () => {
  beforeEach(async () => {
    await resetStore();
  });

  it('prevents other orgs from creating bounties with a task type they do not own', async () => {
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
      // Org A owns the task type.
      const emailA = `own+${Date.now()}@example.com`;
      const passwordA = 'password123';
      const regA = await request(app.server).post('/api/org/register').send({ orgName: 'Owner Org', email: emailA, password: passwordA, apiKeyName: 'default' });
      expect(regA.status).toBe(200);
      const keyA = await request(app.server).post('/api/org/api-keys').send({ email: emailA, password: passwordA, name: 'ci' });
      expect(keyA.status).toBe(200);
      const tokenA = String(keyA.body.token);

      // Create app with taskType "my_task".
      const createApp = await request(app.server)
        .post('/api/org/apps')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ slug: 'my-app', taskType: 'my_task', name: 'My App', public: true });
      expect(createApp.status).toBe(200);
      const appId = String(createApp.body?.app?.id ?? '');
      expect(appId).toBeTruthy();

      // Verify origin for org A.
      const addOriginA = await request(app.server)
        .post('/api/origins')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ origin: originUrl, method: 'http_file' });
      expect(addOriginA.status).toBe(200);
      const originIdA = String(addOriginA.body?.origin?.id ?? '');
      verifyToken = String(addOriginA.body?.origin?.token ?? '');
      expect(verifyToken).toMatch(/^pw_verify_/);
      const checkA = await request(app.server).post(`/api/origins/${encodeURIComponent(originIdA)}/check`).set('Authorization', `Bearer ${tokenA}`);
      expect(checkA.status).toBe(200);
      expect(checkA.body?.origin?.status).toBe('verified');

      // Org B tries to use my_task.
      const emailB = `other+${Date.now()}@example.com`;
      const passwordB = 'password123';
      const regB = await request(app.server).post('/api/org/register').send({ orgName: 'Other Org', email: emailB, password: passwordB, apiKeyName: 'default' });
      expect(regB.status).toBe(200);
      const keyB = await request(app.server).post('/api/org/api-keys').send({ email: emailB, password: passwordB, name: 'ci' });
      expect(keyB.status).toBe(200);
      const tokenB = String(keyB.body.token);

      // Verify origin for org B.
      const addOriginB = await request(app.server)
        .post('/api/origins')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ origin: originUrl, method: 'http_file' });
      expect(addOriginB.status).toBe(200);
      const originIdB = String(addOriginB.body?.origin?.id ?? '');
      verifyToken = String(addOriginB.body?.origin?.token ?? '');
      const checkB = await request(app.server).post(`/api/origins/${encodeURIComponent(originIdB)}/check`).set('Authorization', `Bearer ${tokenB}`);
      expect(checkB.status).toBe(200);
      expect(checkB.body?.origin?.status).toBe('verified');

      const badBounty = await request(app.server)
        .post('/api/bounties')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({
          title: 'B',
          description: 'D',
          allowedOrigins: [originUrl],
          requiredProofs: 1,
          fingerprintClassesRequired: ['desktop_us'],
          payoutCents: 1000,
          taskDescriptor: {
            schema_version: 'v1',
            type: 'my_task',
            capability_tags: ['http'],
            input_spec: {},
            output_spec: { required_artifacts: [{ kind: 'other', count: 1, label: 'result.json' }] },
            freshness_sla_sec: 3600,
          },
        });
      expect(badBounty.status).toBe(403);
      expect(badBounty.body?.error?.code).toBe('forbidden');

      // If owner disables the app, even the owner org cannot create new bounties for it.
      const disable = await request(app.server)
        .patch(`/api/org/apps/${encodeURIComponent(appId)}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ status: 'disabled' });
      expect(disable.status).toBe(200);

      const disabledBounty = await request(app.server)
        .post('/api/bounties')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          title: 'B2',
          description: 'D2',
          allowedOrigins: [originUrl],
          requiredProofs: 1,
          fingerprintClassesRequired: ['desktop_us'],
          payoutCents: 1000,
          taskDescriptor: {
            schema_version: 'v1',
            type: 'my_task',
            capability_tags: ['http'],
            input_spec: {},
            output_spec: { required_artifacts: [{ kind: 'other', count: 1, label: 'result.json' }] },
            freshness_sla_sec: 3600,
          },
        });
      expect(disabledBounty.status).toBe(409);
      expect(disabledBounty.body?.error?.code).toBe('app_disabled');
    } finally {
      await new Promise<void>((resolve) => originServer.close(() => resolve()));
      await app.close();
    }
  });
});

