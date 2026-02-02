import { createHash } from 'crypto';
import { nanoid } from 'nanoid';

const base = (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const token = process.env.WORKER_TOKEN;
if (!token) {
  console.error('Set WORKER_TOKEN env var (from /api/workers/register) before running upload burst.');
  process.exit(1);
}

const uploadsTotal = Number(process.env.UPLOAD_COUNT ?? 50);
const concurrency = Number(process.env.UPLOAD_CONCURRENCY ?? 5);
const uploadBytes = Number(process.env.UPLOAD_BYTES ?? 1024);
const contentType = process.env.UPLOAD_CONTENT_TYPE ?? 'text/plain';
const filenameBase = process.env.UPLOAD_FILENAME ?? 'load.txt';

if (!Number.isFinite(uploadsTotal) || uploadsTotal <= 0) throw new Error('invalid UPLOAD_COUNT');
if (!Number.isFinite(concurrency) || concurrency <= 0) throw new Error('invalid UPLOAD_CONCURRENCY');
if (!Number.isFinite(uploadBytes) || uploadBytes <= 0) throw new Error('invalid UPLOAD_BYTES');

async function api(path, { method = 'GET', json } = {}) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const res = await fetch(`${base}${path}`, { method, headers, body: json ? JSON.stringify(json) : undefined });
  const txt = await res.text();
  const body = txt ? JSON.parse(txt) : null;
  return { res, body };
}

async function ensureClaimedJob() {
  const explicit = (process.env.JOB_ID ?? '').trim();
  if (explicit) return explicit;

  const next = await api('/api/jobs/next');
  if (!next.res.ok) throw new Error(`jobs_next_failed:${next.res.status}`);
  if (next.body?.state !== 'claimable') throw new Error(`jobs_next_not_claimable:${next.body?.state ?? 'unknown'}`);
  const jobId = next.body?.data?.job?.jobId;
  if (!jobId) throw new Error('missing_jobId');

  const claim = await api(`/api/jobs/${encodeURIComponent(jobId)}/claim`, { method: 'POST' });
  if (!claim.res.ok) throw new Error(`claim_failed:${claim.res.status}`);
  return jobId;
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function one(jobId, i) {
  const bytes = Buffer.alloc(uploadBytes, i % 256);
  const sha = sha256Hex(bytes);

  const presign = await api('/api/uploads/presign', {
    method: 'POST',
    json: {
      jobId,
      files: [{ filename: `${i}-${filenameBase}`, contentType, sizeBytes: bytes.byteLength }],
    },
  });
  if (!presign.res.ok) throw new Error(`presign_failed:${presign.res.status}:${JSON.stringify(presign.body)}`);
  const upload = presign.body?.uploads?.[0];
  if (!upload?.url || !upload?.artifactId) throw new Error('bad_presign_response');

  const putHeaders = { ...(upload.headers ?? {}) };
  if (String(upload.url).includes('/api/uploads/local/')) {
    putHeaders.Authorization = `Bearer ${token}`;
  }

  const put = await fetch(upload.url, { method: 'PUT', headers: putHeaders, body: bytes });
  if (!put.ok) throw new Error(`put_failed:${put.status}`);

  const complete = await api('/api/uploads/complete', {
    method: 'POST',
    json: { artifactId: upload.artifactId, sha256: sha, sizeBytes: bytes.byteLength },
  });
  if (!complete.res.ok) throw new Error(`complete_failed:${complete.res.status}`);

  return { artifactId: upload.artifactId };
}

(async () => {
  const jobId = await ensureClaimedJob();
  console.log(`Using jobId=${jobId} base=${base} total=${uploadsTotal} concurrency=${concurrency}`);

  let started = 0;
  let succeeded = 0;
  let failed = 0;
  const t0 = Date.now();

  let idx = 0;
  const workers = Array.from({ length: concurrency }).map(async () => {
    while (true) {
      const i = idx++;
      if (i >= uploadsTotal) return;
      started += 1;
      try {
        await one(jobId, i);
        succeeded += 1;
      } catch (err) {
        failed += 1;
        console.error(`upload ${i} failed:`, String((err && err.message) || err));
      }
    }
  });

  await Promise.all(workers);
  const dt = (Date.now() - t0) / 1000;
  console.log(JSON.stringify({ started, succeeded, failed, seconds: dt, rps: succeeded / Math.max(0.001, dt) }, null, 2));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

