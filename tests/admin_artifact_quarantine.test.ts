import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createHash } from 'crypto';
import { buildServer } from '../src/server.js';
import { resetStore } from '../src/store.js';

function sha256Hex(buf: Buffer) {
  return createHash('sha256').update(buf).digest('hex');
}

describe('admin artifact quarantine', () => {
  beforeEach(async () => {
    await resetStore();
  });

  it('blocks downloads after admin quarantine', async () => {
    const app = buildServer();
    await app.ready();

    try {
      // Register worker and claim a job.
      const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'W', capabilities: { browser: true } });
      expect(reg.status).toBe(200);
      const workerToken = String(reg.body.token);

      const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${workerToken}`);
      expect(next.status).toBe(200);
      expect(next.body.state).toBe('claimable');
      const jobId = String(next.body.data.job.jobId);

      const claim = await request(app.server).post(`/api/jobs/${encodeURIComponent(jobId)}/claim`).set('Authorization', `Bearer ${workerToken}`).send();
      expect(claim.status).toBe(200);

      const bytes = Buffer.from('hello quarantine\n', 'utf8');
      const presign = await request(app.server)
        .post('/api/uploads/presign')
        .set('Authorization', `Bearer ${workerToken}`)
        .send({ jobId, files: [{ filename: 'hello.txt', contentType: 'text/plain', sizeBytes: bytes.byteLength }] });
      expect(presign.status).toBe(200);
      const upload = presign.body.uploads[0];

      // Supertest runs the server in-process; upload via the local PUT route instead of `fetch`.
      const uploadPath = new URL(String(upload.url)).pathname;
      const putRes = await request(app.server)
        .put(uploadPath)
        .set('Authorization', `Bearer ${workerToken}`)
        .set(upload.headers || {})
        .send(bytes);
      expect(putRes.status).toBe(200);

      const complete = await request(app.server)
        .post('/api/uploads/complete')
        .set('Authorization', `Bearer ${workerToken}`)
        .send({ artifactId: upload.artifactId, sha256: sha256Hex(bytes), sizeBytes: bytes.byteLength });
      expect(complete.status).toBe(200);

      const { handleArtifactScanRequested } = await import('../workers/handlers.js');
      await handleArtifactScanRequested({ artifactId: upload.artifactId });

      // Quarantine as admin.
      const adminToken = process.env.ADMIN_TOKEN || 'pw_adm_internal';
      const q = await request(app.server)
        .post(`/api/admin/artifacts/${encodeURIComponent(upload.artifactId)}/quarantine`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'policy' });
      expect(q.status).toBe(200);

      // Artifact status reflects block.
      const info = await request(app.server).get(`/api/artifacts/${encodeURIComponent(upload.artifactId)}`).set('Authorization', `Bearer ${adminToken}`);
      expect(info.status).toBe(200);
      expect(info.body.status).toBe('blocked');

      // Worker download is blocked.
      const dl = await request(app.server)
        .get(`/api/artifacts/${encodeURIComponent(upload.artifactId)}/download`)
        .set('Authorization', `Bearer ${workerToken}`)
        .send();
      expect(dl.status).toBe(422);
      expect(dl.body?.error?.code).toBe('blocked');
    } finally {
      await app.close();
    }
  });
});
