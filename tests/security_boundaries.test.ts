import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildServer } from '../src/server.js';

describe('Security boundaries', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env mutations for other tests (single process).
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete (process.env as any)[k];
    }
    for (const [k, v] of Object.entries(originalEnv)) {
      process.env[k] = v;
    }
  });

  it('enforces CSRF for session-protected POSTs', async () => {
    const app = buildServer();
    await app.ready();

    const agent = request.agent(app.server);

    const login = await agent.post('/api/auth/login').send({ email: 'buyer@example.com', password: 'password' });
    expect(login.status).toBe(200);
    const csrf = login.body.csrfToken as string;
    expect(typeof csrf).toBe('string');
    expect(csrf.length).toBeGreaterThan(10);

    // Missing CSRF should be rejected.
    const noCsrf = await agent.post('/api/session/api-keys').send({ name: 'test' });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body?.error?.code).toBe('csrf');

    // Correct CSRF should succeed.
    const ok = await agent.post('/api/session/api-keys').set('X-CSRF-Token', csrf).send({ name: 'test' });
    expect(ok.status).toBe(200);
    expect(ok.body?.token).toMatch(/^pw_bu_/);
  });

  it('sets CORS headers and answers OPTIONS only for allowlisted origins', async () => {
    process.env.CORS_ALLOW_ORIGINS = 'https://buyer.example.com';

    const app = buildServer();
    await app.ready();

    const preflightAllowed = await request(app.server)
      .options('/api/jobs/next')
      .set('Origin', 'https://buyer.example.com')
      .set('Access-Control-Request-Method', 'GET');
    expect(preflightAllowed.status).toBe(204);
    expect(preflightAllowed.headers['access-control-allow-origin']).toBe('https://buyer.example.com');
    expect(preflightAllowed.headers['access-control-allow-credentials']).toBe('true');

    const preflightDenied = await request(app.server)
      .options('/api/jobs/next')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'GET');
    expect(preflightDenied.status).toBe(404);
    expect(preflightDenied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('requires HTTPS in production when x-forwarded-proto is present', async () => {
    const app = buildServer();
    await app.ready();

    process.env.NODE_ENV = 'production';

    const blocked = await request(app.server).get('/api/jobs/next').set('X-Forwarded-Proto', 'http');
    expect(blocked.status).toBe(400);
    expect(blocked.body?.error?.code).toBe('https_required');

    const allowed = await request(app.server).get('/api/jobs/next').set('X-Forwarded-Proto', 'https');
    expect(allowed.status).not.toBe(400);
  });
});

