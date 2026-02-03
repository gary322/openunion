import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildServer } from '../src/server.js';
import { resetStore } from '../src/store.js';
import { pool } from '../src/db/client.js';
import { createOrgApiKey } from '../src/buyer.js';

describe('Multi-tenant isolation', () => {
  beforeEach(async () => {
    await resetStore();
  });

  it('prevents buyer orgs from listing/mutating each other’s bounties and downloading each other’s artifacts', async () => {
    const app = buildServer();
    await app.ready();

    // Create org2 + a verified origin so it can create/publish bounties.
    const org2Id = 'org_two';
    await pool.query(`INSERT INTO orgs(id,name,created_at) VALUES ($1,$2,now()) ON CONFLICT (id) DO NOTHING`, [
      org2Id,
      'Org Two',
    ]);
    await pool.query(
      `INSERT INTO origins(id,org_id,origin,status,method,token,verified_at,created_at)
       VALUES ($1,$2,$3,'verified','dns_txt',$4,now(),now())
       ON CONFLICT (id) DO NOTHING`,
      ['origin_two', org2Id, 'https://example.com', 'seed']
    );

    const org2Key = await createOrgApiKey(org2Id, 'ci');
    const org2Token = org2Key.token;

    // Fund org2 so publish can reserve budget.
    await pool.query(
      `INSERT INTO billing_accounts(id,org_id,balance_cents,currency,created_at,updated_at)
       VALUES ($1,$2,$3,'usd',now(),now())
       ON CONFLICT (org_id) DO UPDATE SET balance_cents = EXCLUDED.balance_cents, updated_at = now()`,
      [`acct_${org2Id}`, org2Id, 100_000]
    );

    const bounty2 = await request(app.server)
      .post('/api/bounties')
      .set('Authorization', `Bearer ${org2Token}`)
      .send({
        title: 'Org2 bounty',
        description: 'Should not be visible to org1',
        allowedOrigins: ['https://example.com'],
        payoutCents: 1200,
        requiredProofs: 1,
        fingerprintClassesRequired: ['desktop_us'],
        tags: ['org2'],
      });
    expect(bounty2.status).toBe(200);
    const bounty2Id = bounty2.body.id as string;

    const pub2 = await request(app.server).post(`/api/bounties/${bounty2Id}/publish`).set('Authorization', `Bearer ${org2Token}`).send();
    expect(pub2.status).toBe(200);

    // Org1 buyer token (demo org) via credentialed key issuance endpoint.
    const keyResp = await request(app.server).post('/api/org/api-keys').send({ email: 'buyer@example.com', password: 'password', name: 'ci' });
    expect(keyResp.status).toBe(200);
    const org1Token = keyResp.body.token as string;

    // Org1 listing should NOT include org2 bounty.
    const list1 = await request(app.server).get('/api/bounties?page=1&limit=50').set('Authorization', `Bearer ${org1Token}`);
    expect(list1.status).toBe(200);
    const ids = (list1.body.bounties ?? []).map((b: any) => b.id);
    expect(ids).not.toContain(bounty2Id);

    // Org1 cannot read jobs for org2 bounty.
    const jobsForbidden = await request(app.server)
      .get(`/api/bounties/${bounty2Id}/jobs?page=1&limit=50`)
      .set('Authorization', `Bearer ${org1Token}`);
    expect(jobsForbidden.status).toBe(403);
    expect(jobsForbidden.body?.error?.code).toBe('forbidden');

    // Org1 cannot mutate org2 bounty.
    const pauseForbidden = await request(app.server).post(`/api/bounties/${bounty2Id}/pause`).set('Authorization', `Bearer ${org1Token}`).send();
    expect(pauseForbidden.status).toBe(403);
    expect(pauseForbidden.body?.error?.code).toBe('forbidden');

    // Create an artifact under org2 via a worker upload, then verify org1 cannot download it.
    const jobRow = await pool.query<{ id: string }>('SELECT id FROM jobs WHERE bounty_id=$1 LIMIT 1', [bounty2Id]);
    const job2Id = jobRow.rows[0]?.id;
    expect(job2Id).toBeTruthy();

    const worker = await request(app.server).post('/api/workers/register').send({ displayName: 'W', capabilities: { browser: true } });
    const workerToken = worker.body.token as string;
    const claim = await request(app.server).post(`/api/jobs/${job2Id}/claim`).set('Authorization', `Bearer ${workerToken}`).send();
    expect(claim.status).toBe(200);

    const presign = await request(app.server)
      .post('/api/uploads/presign')
      .set('Authorization', `Bearer ${workerToken}`)
      .send({ jobId: job2Id, files: [{ filename: 'shot.png', contentType: 'image/png' }] });
    expect(presign.status).toBe(200);

    const upload = presign.body.uploads[0];
    const uploadPath = new URL(upload.url).pathname;
    const put = await request(app.server)
      .put(uploadPath)
      .set('Authorization', `Bearer ${workerToken}`)
      .set(upload.headers || {})
      .send(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    expect(put.status).toBe(200);

    const artifactId = new URL(upload.finalUrl).pathname.split('/')[3];
    expect(artifactId).toBeTruthy();

    // Org2 buyer token can download.
    const dlOrg2 = await request(app.server).get(`/api/artifacts/${artifactId}/download`).set('Authorization', `Bearer ${org2Token}`);
    expect(dlOrg2.status).toBe(200);

    // Org2 buyer token can view artifact status.
    const stOrg2 = await request(app.server).get(`/api/artifacts/${artifactId}`).set('Authorization', `Bearer ${org2Token}`);
    expect(stOrg2.status).toBe(200);
    expect(stOrg2.body?.id).toBe(artifactId);
    expect(stOrg2.body?.status).toBe('scanned');

    // Org1 buyer token cannot download org2 artifact.
    const dlOrg1 = await request(app.server).get(`/api/artifacts/${artifactId}/download`).set('Authorization', `Bearer ${org1Token}`);
    expect(dlOrg1.status).toBe(403);

    // Org1 buyer token cannot view org2 artifact status.
    const stOrg1 = await request(app.server).get(`/api/artifacts/${artifactId}`).set('Authorization', `Bearer ${org1Token}`);
    expect(stOrg1.status).toBe(403);

    // Worker who uploaded can view artifact status.
    const stWorker = await request(app.server).get(`/api/artifacts/${artifactId}`).set('Authorization', `Bearer ${workerToken}`);
    expect(stWorker.status).toBe(200);
    expect(stWorker.body?.status).toBe('scanned');

    await app.close();
  });
});
