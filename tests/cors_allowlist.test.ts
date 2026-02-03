import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { buildServer } from '../src/server.js';
import { resetStore } from '../src/store.js';

describe('Org CORS allowlist (buyer tokens)', () => {
  beforeEach(async () => {
    await resetStore();
  });

  it('allows only allowlisted origins for buyer-token API calls', async () => {
    const app = buildServer();
    await app.ready();

    // Register a platform org (returns a buyer token).
    const reg = await request(app.server)
      .post('/api/org/register')
      .send({ orgName: 'CORS Org', email: `cors_${Date.now()}@example.com`, password: 'password123', apiKeyName: 'default' });
    expect(reg.status).toBe(200);
    const token = String(reg.body?.token ?? '');
    expect(token.startsWith('pw_bu_')).toBeTruthy();

    // Configure allowlisted origins.
    const allowOrigin = 'https://ui.example.com';
    const set = await request(app.server)
      .put('/api/org/cors-allow-origins')
      .set('Authorization', `Bearer ${token}`)
      .send({ origins: [allowOrigin] });
    expect(set.status).toBe(200);

    // Preflight (union allowlist allows OPTIONS).
    const preflight = await request(app.server)
      .options('/api/bounties')
      .set('Origin', allowOrigin)
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'Authorization');
    expect(preflight.status).toBe(204);
    expect(String(preflight.headers['access-control-allow-origin'] ?? '')).toBe(allowOrigin);

    // Allowed origin works.
    const ok = await request(app.server)
      .get('/api/bounties')
      .set('Authorization', `Bearer ${token}`)
      .set('Origin', allowOrigin);
    expect(ok.status).toBe(200);
    expect(String(ok.headers['access-control-allow-origin'] ?? '')).toBe(allowOrigin);

    // Non-allowlisted origin is rejected for buyer token calls.
    const badOrigin = 'https://evil.example';
    const denied = await request(app.server)
      .get('/api/bounties')
      .set('Authorization', `Bearer ${token}`)
      .set('Origin', badOrigin);
    expect(denied.status).toBe(403);
    expect(denied.body?.error?.code).toBe('cors_forbidden');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});

