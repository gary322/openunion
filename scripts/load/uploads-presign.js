import autocannon from 'autocannon';

const base = (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { res, json };
}

async function ensureWorkerAndJob() {
  let token = process.env.WORKER_TOKEN;
  if (!token) {
    const reg = await api('/api/workers/register', { method: 'POST', body: { displayName: 'load', capabilities: { browser: true } } });
    if (!reg.res.ok) throw new Error(`worker_register_failed:${reg.res.status}`);
    token = reg.json.token;
  }

  // Claim a job so presign can be exercised.
  const next = await api('/api/jobs/next', { token });
  if (!next.res.ok || next.json?.state !== 'claimable') {
    throw new Error('no_claimable_job_for_presign_load');
  }
  const jobId = next.json.data.job.jobId;
  const claim = await api(`/api/jobs/${encodeURIComponent(jobId)}/claim`, { method: 'POST', token });
  if (!claim.res.ok) throw new Error(`claim_failed:${claim.res.status}`);
  return { token, jobId };
}

const { token, jobId } = await ensureWorkerAndJob();

const url = `${base}/api/uploads/presign`;
const body = JSON.stringify({
  jobId,
  files: [{ filename: 'shot.png', contentType: 'image/png', sizeBytes: 1234 }],
});

const instance = autocannon({
  url,
  method: 'POST',
  connections: Number(process.env.LOAD_CONNECTIONS ?? 20),
  duration: Number(process.env.LOAD_DURATION_SEC ?? 10),
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body,
});

autocannon.track(instance, { renderProgressBar: true });

