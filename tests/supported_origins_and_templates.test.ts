import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildServer } from '../src/server.js';
import { resetStore } from '../src/store.js';

describe('Supported origins + marketplace templates', () => {
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

  async function registerBuyer() {
    const email = `buyer_${Date.now()}@example.com`;
    const res = await request(app.server).post('/api/org/register').send({ orgName: 'Test Org', email, password: 'password1234', apiKeyName: 'default' });
    expect(res.status).toBe(200);
    return { token: res.body.token as string, orgId: res.body.orgId as string };
  }

  it('auto-generates marketplace start url from query and injects selectors template', async () => {
    const buyer = await registerBuyer();

    const create = await request(app.server)
      .post('/api/bounties')
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({
        title: 'Marketplace smoke',
        description: 'test',
        payoutCents: 100,
        requiredProofs: 1,
        taskDescriptor: {
          schema_version: 'v1',
          type: 'marketplace_drops',
          capability_tags: ['browser', 'screenshot'],
          input_spec: { query: 'rtx 4090' },
          output_spec: { required_artifacts: [{ kind: 'screenshot', count: 1 }, { kind: 'other', count: 1, label_prefix: 'results' }], results_json: true },
          freshness_sla_sec: 600,
        },
      });

    expect(create.status).toBe(200);
    const td = create.body.taskDescriptor as any;
    expect(String(td?.input_spec?.url ?? '')).toContain('ebay.com');
    expect(typeof td?.site_profile?.selectors).toBe('object');
    expect(String(td?.site_profile?.selectors?.items ?? '')).toBeTruthy();
    expect(String(td?.site_profile?.marketplace_wait_selector ?? '')).toBeTruthy();
  });

  it('rejects clips_highlights vod_url that is not a direct mp4 when using supported origins', async () => {
    const buyer = await registerBuyer();

    const create = await request(app.server)
      .post('/api/bounties')
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({
        title: 'Clips smoke',
        description: 'test',
        payoutCents: 100,
        requiredProofs: 1,
        taskDescriptor: {
          schema_version: 'v1',
          type: 'clips_highlights',
          capability_tags: ['ffmpeg'],
          input_spec: { vod_url: 'https://storage.googleapis.com/video/not-mp4.txt', start_sec: 0, duration_sec: 5 },
          output_spec: { required_artifacts: [{ kind: 'video', count: 1, label_prefix: 'clip' }] },
          freshness_sla_sec: 3600,
        },
      });

    expect(create.status).toBe(400);
    expect(String(create.body?.error?.message ?? '')).toContain('direct_mp4');
  });

  it('supports buyer origin request -> admin approve -> origin becomes supported', async () => {
    const buyer = await registerBuyer();

    // System app id is stable in seedBuiltInApps.
    const appId = 'app_marketplace';
    const origin = 'https://example.org';

    const reqCreate = await request(app.server)
      .post(`/api/apps/${appId}/origin-requests`)
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({ origin, message: 'please support this site' });
    expect(reqCreate.status).toBe(200);
    expect(reqCreate.body?.request?.origin).toBe(origin);
    const requestId = String(reqCreate.body.request.id);

    const review = await request(app.server)
      .post(`/api/admin/origin-requests/${requestId}/review`)
      .set('Authorization', 'Bearer pw_adm_internal')
      .send({ action: 'approve', notes: 'ok' });
    expect(review.status).toBe(200);
    expect(review.body?.request?.status).toBe('approved');

    const supported = await request(app.server).get(`/api/apps/${appId}/supported-origins`);
    expect(supported.status).toBe(200);
    expect(Array.isArray(supported.body?.supportedOrigins)).toBe(true);
    expect(supported.body.supportedOrigins).toContain(origin);
  });
});

