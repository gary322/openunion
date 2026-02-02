import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash } from 'crypto';
import { S3Client, CreateBucketCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { buildServer } from '../src/server.js';
import { resetStore } from '../src/store.js';
import { db } from '../src/db/client.js';

async function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256Hex(buf: Buffer) {
  return createHash('sha256').update(buf).digest('hex');
}

function testS3Client() {
  const endpoint = process.env.STORAGE_ENDPOINT;
  const region = process.env.S3_REGION ?? 'us-east-1';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? 'minioadmin';
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin';
  if (!endpoint) throw new Error('STORAGE_ENDPOINT not set');
  return new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
}

async function ensureBucket(s3: S3Client, bucket: string) {
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch {
    // already exists
  }
}

async function waitForClamdReady(timeoutMs = 60_000) {
  const host = process.env.CLAMD_HOST ?? '127.0.0.1';
  const port = Number(process.env.CLAMD_PORT ?? 3310);
  const { connect } = await import('net');

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = connect({ host, port }, () => {
        sock.write('PING\n');
      });
      sock.setTimeout(2000);
      let resp = '';
      sock.on('data', (d) => (resp += d.toString('utf8')));
      const done = (v: boolean) => {
        try {
          sock.destroy();
        } catch {
          // ignore
        }
        resolve(v);
      };
      sock.on('timeout', () => done(false));
      sock.on('error', () => done(false));
      sock.on('close', () => done(resp.toUpperCase().includes('PONG')));
    });
    if (ok) return;
    await wait(500);
  }
  throw new Error('clamd_not_ready');
}

const enabled = process.env.RUN_S3_SCAN_TESTS === '1' && (process.env.STORAGE_BACKEND ?? 'local') === 's3';

(enabled ? describe : describe.skip)('S3 upload + scan pipeline (MinIO + clamd)', () => {
  beforeAll(async () => {
    // Ensure buckets exist.
    const s3 = testS3Client();
    const staging = process.env.S3_BUCKET_STAGING ?? 'proofwork-staging';
    const clean = process.env.S3_BUCKET_CLEAN ?? 'proofwork-clean';
    const quarantine = process.env.S3_BUCKET_QUARANTINE ?? 'proofwork-quarantine';
    await ensureBucket(s3, staging);
    await ensureBucket(s3, clean);
    await ensureBucket(s3, quarantine);

    process.env.SCANNER_ENGINE = 'clamd';
    process.env.CLAMD_HOST = process.env.CLAMD_HOST ?? '127.0.0.1';
    process.env.CLAMD_PORT = process.env.CLAMD_PORT ?? '3310';
    process.env.CLAMD_TIMEOUT_MS = process.env.CLAMD_TIMEOUT_MS ?? '15000';
    await waitForClamdReady();
  });

  beforeEach(async () => {
    await resetStore();
  });

  it('moves clean upload staging→clean and allows download', async () => {
    const s3 = testS3Client();
    const app = buildServer();
    await app.ready();

    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'W', capabilities: { browser: true } });
    expect(reg.status).toBe(200);
    const token = reg.body.token as string;

    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${token}`);
    expect(next.status).toBe(200);
    expect(next.body.state).toBe('claimable');
    const jobId = next.body.data.job.jobId as string;

    const claim = await request(app.server).post(`/api/jobs/${jobId}/claim`).set('Authorization', `Bearer ${token}`).send();
    expect(claim.status).toBe(200);

    const bytes = Buffer.from('hello world\n', 'utf8');
    const presign = await request(app.server)
      .post('/api/uploads/presign')
      .set('Authorization', `Bearer ${token}`)
      .send({ jobId, files: [{ filename: 'hello.txt', contentType: 'text/plain', sizeBytes: bytes.byteLength }] });
    expect(presign.status).toBe(200);
    const upload = presign.body.uploads[0];

    const putRes = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: bytes });
    expect(putRes.status).toBe(200);

    const complete = await request(app.server)
      .post('/api/uploads/complete')
      .set('Authorization', `Bearer ${token}`)
      .send({ artifactId: upload.artifactId, sha256: sha256Hex(bytes), sizeBytes: bytes.byteLength });
    expect(complete.status).toBe(200);

    const { handleArtifactScanRequested } = await import('../workers/handlers.js');
    await handleArtifactScanRequested({ artifactId: upload.artifactId });

    const art = await db.selectFrom('artifacts').selectAll().where('id', '=', upload.artifactId).executeTakeFirstOrThrow();
    expect(art.status).toBe('scanned');
    expect(art.bucket_kind).toBe('clean');

    // Download should redirect to signed URL.
    const dl = await request(app.server).get(`/api/artifacts/${upload.artifactId}/download`).set('Authorization', `Bearer ${token}`).send();
    expect([302, 303]).toContain(dl.status);
    const signedUrl = dl.headers['location'] as string;
    expect(typeof signedUrl).toBe('string');
    const body = Buffer.from(await (await fetch(signedUrl)).arrayBuffer());
    expect(body.equals(bytes)).toBe(true);

    // Object exists in clean bucket.
    const cleanBucket = process.env.S3_BUCKET_CLEAN ?? 'proofwork-clean';
    await s3.send(new HeadObjectCommand({ Bucket: cleanBucket, Key: art.storage_key as string }));
  });

  it('moves infected upload staging→quarantine and blocks download', async () => {
    const s3 = testS3Client();
    const app = buildServer();
    await app.ready();

    const reg = await request(app.server).post('/api/workers/register').send({ displayName: 'W', capabilities: { browser: true } });
    expect(reg.status).toBe(200);
    const token = reg.body.token as string;

    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${token}`);
    expect(next.body.state).toBe('claimable');
    const jobId = next.body.data.job.jobId as string;
    await request(app.server).post(`/api/jobs/${jobId}/claim`).set('Authorization', `Bearer ${token}`).send();

    const eicar =
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    const bytes = Buffer.from(eicar, 'utf8');

    const presign = await request(app.server)
      .post('/api/uploads/presign')
      .set('Authorization', `Bearer ${token}`)
      .send({ jobId, files: [{ filename: 'eicar.txt', contentType: 'text/plain', sizeBytes: bytes.byteLength }] });
    expect(presign.status).toBe(200);
    const upload = presign.body.uploads[0];

    const putRes = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: bytes });
    expect(putRes.status).toBe(200);

    await request(app.server)
      .post('/api/uploads/complete')
      .set('Authorization', `Bearer ${token}`)
      .send({ artifactId: upload.artifactId, sha256: sha256Hex(bytes), sizeBytes: bytes.byteLength });

    const { handleArtifactScanRequested } = await import('../workers/handlers.js');
    await expect(handleArtifactScanRequested({ artifactId: upload.artifactId })).rejects.toThrow();

    const art = await db.selectFrom('artifacts').selectAll().where('id', '=', upload.artifactId).executeTakeFirstOrThrow();
    expect(art.status).toBe('blocked');
    expect(art.bucket_kind).toBe('quarantine');

    const dl = await request(app.server).get(`/api/artifacts/${upload.artifactId}/download`).set('Authorization', `Bearer ${token}`).send();
    expect(dl.status).toBe(409);

    // Object exists in quarantine bucket.
    const quarantineBucket = process.env.S3_BUCKET_QUARANTINE ?? 'proofwork-quarantine';
    await s3.send(new HeadObjectCommand({ Bucket: quarantineBucket, Key: art.storage_key as string }));
  });
});

