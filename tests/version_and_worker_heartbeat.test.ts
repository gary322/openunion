import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildServer } from '../src/server.js';
import { pool } from '../src/db/client.js';
import { resetStore } from '../src/store.js';

describe('/api/version + worker heartbeat', () => {
  let app: any;

  beforeEach(async () => {
    await resetStore();
    app = buildServer();
    await app.ready();
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('exposes a stable /api/version payload', async () => {
    const res = await request(app.server).get('/api/version');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('proofwork');
    expect(typeof res.body.apiVersion).toBe('number');
    expect(typeof res.body.serverVersion).toBe('string');
    expect(typeof res.body.node).toBe('string');
    expect(typeof res.body.features).toBe('object');
    expect(res.body.features.workerPayoutAddress).toBe(true);
  });

  it('updates workers.last_seen_at via /api/worker/heartbeat and /api/jobs/next', async () => {
    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'A', capabilities: { openclaw: true } });
    expect(reg.status).toBe(200);
    const workerToken = reg.body.token as string;
    const workerId = reg.body.workerId as string;

    const before = await pool.query<{ last_seen_at: Date | null }>('SELECT last_seen_at FROM workers WHERE id=$1', [workerId]);
    const beforeTs = before.rows[0]?.last_seen_at ? new Date(before.rows[0].last_seen_at).getTime() : 0;

    const hb = await request(app.server).post('/api/worker/heartbeat').set('Authorization', `Bearer ${workerToken}`).send({});
    expect(hb.status).toBe(200);
    expect(hb.body.ok).toBe(true);

    const afterHb = await pool.query<{ last_seen_at: Date | null }>('SELECT last_seen_at FROM workers WHERE id=$1', [workerId]);
    const afterHbTs = afterHb.rows[0]?.last_seen_at ? new Date(afterHb.rows[0].last_seen_at).getTime() : 0;
    expect(afterHbTs).toBeGreaterThanOrEqual(beforeTs);

    // jobs/next should also touch last_seen_at
    await new Promise((r) => setTimeout(r, 20));
    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${workerToken}`);
    expect(next.status).toBe(200);

    const afterNext = await pool.query<{ last_seen_at: Date | null }>('SELECT last_seen_at FROM workers WHERE id=$1', [workerId]);
    const afterNextTs = afterNext.rows[0]?.last_seen_at ? new Date(afterNext.rows[0].last_seen_at).getTime() : 0;
    expect(afterNextTs).toBeGreaterThanOrEqual(afterHbTs);
  });
});

