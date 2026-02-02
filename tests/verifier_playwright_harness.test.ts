import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'http';

const enabled = process.env.RUN_PLAYWRIGHT_VERIFIER_TESTS === '1';

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

(enabled ? describe : describe.skip)('Verifier gateway (Playwright harness + evidence uploads)', () => {
  let api: any;
  let apiBaseUrl: string;
  let pageServer: http.Server;
  let pageUrl: string;

  beforeAll(async () => {
    // Pick a deterministic high port to avoid collisions in CI.
    const apiPort = 35000 + Math.floor(Math.random() * 1000);
    apiBaseUrl = `http://127.0.0.1:${apiPort}`;

    process.env.API_BASE_URL = apiBaseUrl;
    process.env.PUBLIC_BASE_URL = apiBaseUrl;
    process.env.STORAGE_BACKEND = 'local';
    process.env.STORAGE_LOCAL_DIR = './var/uploads';
    process.env.VERIFIER_TOKEN = 'pw_vf_internal';

    const { buildServer } = await import('../src/server.js');
    api = buildServer();
    await api.listen({ port: apiPort, host: '127.0.0.1' });

    // Small deterministic page server (same-origin-only assets).
    pageServer = http.createServer((req, res) => {
      if (req.url?.startsWith('/end')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Deterministic</title></head>
  <body>
    <h1 id="ok">OK</h1>
    <script>console.log("deterministic_page_loaded")</script>
  </body>
</html>`);
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });

    await new Promise<void>((resolve) => pageServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = pageServer.address() as any;
    pageUrl = `http://127.0.0.1:${addr.port}/end`;
  });

  afterAll(async () => {
    try {
      await api?.close();
    } catch {
      // ignore
    }
    try {
      await new Promise<void>((resolve) => pageServer.close(() => resolve()));
    } catch {
      // ignore
    }
  });

  it('returns pass and uploads evidence artifacts that are downloadable after scan', async () => {
    const { resetStore, seedDemoData, createWorker, addSubmission } = await import('../src/store.js');
    const { db } = await import('../src/db/client.js');
    await resetStore();
    await seedDemoData();

    // Create a worker + submission in DB so /api/verifier/uploads/presign can associate evidence.
    const w = await createWorker('w', { browser: true });
    const jobRow = await db.selectFrom('jobs').select(['id', 'bounty_id', 'fingerprint_class']).limit(1).executeTakeFirstOrThrow();

    const submissionId = 'sub_' + Math.random().toString(16).slice(2);
    await addSubmission({
      id: submissionId,
      jobId: jobRow.id,
      workerId: w.worker.id,
      manifest: {
        manifestVersion: '1.0',
        jobId: jobRow.id,
        bountyId: jobRow.bounty_id,
        finalUrl: pageUrl,
        reproSteps: ['open page'],
        result: { outcome: 'failure', severity: 'high', expected: 'something', observed: 'something else' },
      },
      artifactIndex: [
        { kind: 'screenshot', label: 'worker_shot', sha256: 'abcd1234', url: 'https://example.com' },
      ],
      status: 'submitted',
      createdAt: Date.now(),
      payoutStatus: 'none',
    } as any);

    const { buildVerifierGateway } = await import('../services/verifier-gateway/server.js');
    const gw = buildVerifierGateway();

    const allowedOrigin = new URL(pageUrl).origin;

    const resp = await gw.inject({
      method: 'POST',
      url: '/run',
      payload: {
        verificationId: 'ver_1',
        submissionId,
        attemptNo: 1,
        jobSpec: { constraints: { allowedOrigins: [allowedOrigin] }, taskDescriptor: { type: 'demo' } },
        submission: {
          submissionId,
          manifest: {
            finalUrl: pageUrl,
            reproSteps: ['open page'],
            result: { expected: 'something', observed: 'something else' },
          },
          artifactIndex: [{ kind: 'screenshot', label: 'worker_shot', sha256: 'abcd1234', url: 'https://example.com' }],
        },
      },
    });

    expect(resp.statusCode).toBe(200);
    const body = resp.json() as any;
    expect(body.verdict).toBe('pass');
    expect(Array.isArray(body.evidenceArtifacts)).toBe(true);

    const uploaded = (body.evidenceArtifacts as any[]).filter((a) => typeof a?.url === 'string' && a.url.includes('/api/artifacts/'));
    expect(uploaded.length).toBeGreaterThan(0);

    // Evidence artifacts are stored as artifacts rows, scanned, and downloadable via verifier token.
    const first = uploaded[0];
    const dl = await fetch(first.url, { headers: { Authorization: `Bearer ${process.env.VERIFIER_TOKEN}` } });
    expect(dl.status).toBe(200);
    const bytes = Buffer.from(await dl.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);
  }, 60_000);
});
