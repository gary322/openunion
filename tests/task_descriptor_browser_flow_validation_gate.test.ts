import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import http from 'http';
import { buildServer } from '../src/server.js';
import { resetStore } from '../src/store.js';

describe('task descriptor browser_flow validation gate', () => {
  beforeEach(async () => {
    await resetStore();
  });

  async function setupBuyerAndVerifiedOrigin(app: any) {
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

    const email = `browserflow+${Date.now()}@example.com`;
    const password = 'password123';
    const reg = await request(app.server).post('/api/org/register').send({ orgName: 'BF Org', email, password, apiKeyName: 'default' });
    expect(reg.status).toBe(200);

    const key = await request(app.server).post('/api/org/api-keys').send({ email, password, name: 'ci' });
    expect(key.status).toBe(200);
    const token = String(key.body.token);

    const createApp = await request(app.server)
      .post('/api/org/apps')
      .set('Authorization', `Bearer ${token}`)
      .send({ slug: 'bf-app', taskType: 'browser_flow_task', name: 'Browser Flow App', public: true });
    expect(createApp.status).toBe(200);

    const addOrigin = await request(app.server)
      .post('/api/origins')
      .set('Authorization', `Bearer ${token}`)
      .send({ origin: originUrl, method: 'http_file' });
    expect(addOrigin.status).toBe(200);
    const originId = String(addOrigin.body?.origin?.id ?? '');
    verifyToken = String(addOrigin.body?.origin?.token ?? '');
    expect(verifyToken).toMatch(/^pw_verify_/);

    const check = await request(app.server).post(`/api/origins/${encodeURIComponent(originId)}/check`).set('Authorization', `Bearer ${token}`);
    expect(check.status).toBe(200);
    expect(check.body?.origin?.status).toBe('verified');

    return {
      originServer,
      originUrl,
      buyerToken: token,
      async close() {
        await new Promise<void>((resolve) => originServer.close(() => resolve()));
      },
    };
  }

  it('rejects extract.fn when the server-side browser_flow gate is enabled', async () => {
    const app = buildServer({ taskDescriptorBrowserFlowValidationGate: true });
    await app.ready();

    const setup = await setupBuyerAndVerifiedOrigin(app);
    try {
      const res = await request(app.server)
        .post('/api/bounties')
        .set('Authorization', `Bearer ${setup.buyerToken}`)
        .send({
          title: 'B',
          description: 'D',
          allowedOrigins: [setup.originUrl],
          requiredProofs: 1,
          fingerprintClassesRequired: ['desktop_us'],
          payoutCents: 1000,
          taskDescriptor: {
            schema_version: 'v1',
            type: 'browser_flow_task',
            capability_tags: ['browser', 'screenshot'],
            input_spec: { url: `${setup.originUrl}/task` },
            output_spec: { required_artifacts: [{ kind: 'screenshot', count: 1 }] },
            site_profile: {
              browser_flow: {
                steps: [{ op: 'extract', key: 'x', ref: '1', fn: '() => 1' }],
              },
            },
          },
        });
      expect(res.status).toBe(400);
      expect(res.body?.error?.code).toBe('invalid_task_descriptor');
      expect(String(res.body?.error?.message ?? '')).toContain('browser_flow_invalid');
    } finally {
      await setup.close();
      await app.close();
    }
  });

  it('rejects value_env when the server-side browser_flow gate is enabled', async () => {
    const app = buildServer({ taskDescriptorBrowserFlowValidationGate: true });
    await app.ready();

    const setup = await setupBuyerAndVerifiedOrigin(app);
    try {
      const res = await request(app.server)
        .post('/api/bounties')
        .set('Authorization', `Bearer ${setup.buyerToken}`)
        .send({
          title: 'B',
          description: 'D',
          allowedOrigins: [setup.originUrl],
          requiredProofs: 1,
          fingerprintClassesRequired: ['desktop_us'],
          payoutCents: 1000,
          taskDescriptor: {
            schema_version: 'v1',
            type: 'browser_flow_task',
            capability_tags: ['browser', 'screenshot'],
            input_spec: { url: `${setup.originUrl}/task` },
            output_spec: { required_artifacts: [{ kind: 'screenshot', count: 1 }] },
            site_profile: {
              browser_flow: {
                steps: [{ op: 'fill', role: 'textbox', name: 'Query', value_env: 'PW_TEST' }],
              },
            },
          },
        });
      expect(res.status).toBe(400);
      expect(res.body?.error?.code).toBe('invalid_task_descriptor');
      expect(String(res.body?.error?.message ?? '')).toContain('value_env_forbidden');
    } finally {
      await setup.close();
      await app.close();
    }
  });
});

