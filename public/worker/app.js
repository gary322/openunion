const apiBase = window.location.origin;
document.getElementById('apiBase').textContent = apiBase;

function $(id) {
  return document.getElementById(id);
}

function setStatus(id, text, kind) {
  const el = $(id);
  el.textContent = text || '';
  el.classList.remove('good', 'bad');
  if (kind) el.classList.add(kind);
}

function pretty(obj) {
  return JSON.stringify(obj, null, 2);
}

function getToken() {
  return localStorage.getItem('pw_worker_token') || '';
}

function setToken(token) {
  localStorage.setItem('pw_worker_token', token);
  $('token').value = token;
}

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { res, json };
}

async function sha256Hex(file) {
  const buf = await file.arrayBuffer();
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(hashBuf);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

let lastNext = null;
let lastClaim = null;
let lastArtifact = null;

function requireTokenUI() {
  const token = $('token').value.trim();
  if (!token) throw new Error('Missing token');
  return token;
}

function requireJobIdUI() {
  const jobId = lastClaim?.data?.job?.jobId || lastNext?.data?.job?.jobId;
  if (!jobId) throw new Error('No job loaded');
  return jobId;
}

function requireBountyIdUI() {
  const bountyId = lastClaim?.data?.job?.bountyId || lastNext?.data?.job?.bountyId;
  if (!bountyId) throw new Error('No bounty loaded');
  return bountyId;
}

async function onRegister() {
  setStatus('authStatus', '', null);
  const displayName = $('regName').value.trim();
  const browser = $('regBrowser').value === 'true';
  const { res, json } = await api('/api/workers/register', {
    method: 'POST',
    body: { displayName, capabilities: { browser } },
  });
  if (!res.ok) {
    setStatus('authStatus', `Register failed (${res.status})`, 'bad');
    return;
  }
  setToken(json.token);
  setStatus('authStatus', `Registered workerId=${json.workerId}`, 'good');
}

async function onSaveToken() {
  setStatus('authStatus', '', null);
  const token = $('token').value.trim();
  if (!token) return setStatus('authStatus', 'Missing token', 'bad');
  setToken(token);
  setStatus('authStatus', 'Token saved', 'good');
}

async function onMe() {
  setStatus('authStatus', '', null);
  const token = requireTokenUI();
  const { res, json } = await api('/api/worker/me', { token });
  if (!res.ok) {
    setStatus('authStatus', `me failed (${res.status})`, 'bad');
    return;
  }
  setStatus('authStatus', `Hello worker ${json.workerId}`, 'good');
}

async function onNext() {
  setStatus('jobStatus', '', null);
  const token = requireTokenUI();
  const { res, json } = await api('/api/jobs/next', { token });
  lastNext = json;
  lastClaim = null;
  $('jobOut').textContent = pretty(json);
  if (!res.ok) {
    setStatus('jobStatus', `jobs/next failed (${res.status})`, 'bad');
    return;
  }
  setStatus('jobStatus', `state=${json.state}`, 'good');
}

async function onClaim() {
  setStatus('jobStatus', '', null);
  const token = requireTokenUI();
  const jobId = requireJobIdUI();
  const { res, json } = await api(`/api/jobs/${jobId}/claim`, { method: 'POST', token });
  lastClaim = json;
  $('jobOut').textContent = pretty(json);
  if (!res.ok) {
    setStatus('jobStatus', `claim failed (${res.status})`, 'bad');
    return;
  }
  setStatus('jobStatus', `claimed leaseNonce=${json.data?.leaseNonce || ''}`, 'good');
}

async function onUpload() {
  setStatus('uploadStatus', '', null);
  const token = requireTokenUI();
  const jobId = requireJobIdUI();
  const file = $('file').files[0];
  if (!file) return setStatus('uploadStatus', 'Pick a file first', 'bad');

  const { res: presRes, json: presJson } = await api('/api/uploads/presign', {
    method: 'POST',
    token,
    body: {
      jobId,
      files: [{ filename: file.name, contentType: file.type || 'application/octet-stream', sizeBytes: file.size }],
    },
  });
  if (!presRes.ok) {
    setStatus('uploadStatus', `presign failed (${presRes.status})`, 'bad');
    $('artifactOut').textContent = pretty(presJson);
    return;
  }

  const upload = presJson.uploads[0];

  // Upload bytes
  const putHeaders = { ...(upload.headers || {}) };
  // Local upload endpoint is authenticated; S3 presigned URLs are not.
  if (String(upload.url || '').includes('/api/uploads/local/')) {
    putHeaders['Authorization'] = `Bearer ${token}`;
  }
  const putRes = await fetch(upload.url, {
    method: 'PUT',
    headers: putHeaders,
    body: file,
  });
  if (!putRes.ok) {
    setStatus('uploadStatus', `upload failed (${putRes.status})`, 'bad');
    return;
  }

  const sha = await sha256Hex(file);
  // Notify API for S3 backends (idempotent for local).
  try {
    await api('/api/uploads/complete', { method: 'POST', token, body: { artifactId: upload.artifactId, sha256: sha, sizeBytes: file.size } });
  } catch {
    // ignore (local backend doesn't need it)
  }
  const kind = $('kind').value;
  const label = $('label').value.trim() || file.name;
  lastArtifact = {
    kind,
    label,
    sha256: sha,
    url: upload.finalUrl,
    sizeBytes: file.size,
    contentType: file.type || 'application/octet-stream',
  };

  $('artifactOut').textContent = pretty(lastArtifact);
  setStatus('uploadStatus', `uploaded artifactId=${upload.artifactId}`, 'good');
}

async function onSubmit() {
  setStatus('submitStatus', '', null);
  const token = requireTokenUI();
  const jobId = requireJobIdUI();
  const bountyId = requireBountyIdUI();
  const workerId = lastClaim?.data?.job?.worker?.workerId; // not provided; we’ll fetch from /me

  if (!lastArtifact) {
    setStatus('submitStatus', 'Upload at least one artifact first', 'bad');
    return;
  }

  const me = await api('/api/worker/me', { token });
  if (!me.res.ok) {
    setStatus('submitStatus', `worker/me failed (${me.res.status})`, 'bad');
    return;
  }

  const expected = $('expected').value.trim() || 'Expected behavior';
  const observed = $('observed').value.trim() || 'Observed behavior';
  const steps = $('steps').value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const allowed = lastClaim?.data?.job?.constraints?.allowedOrigins || lastNext?.data?.job?.constraints?.allowedOrigins || [];
  const targetOrigin = Array.isArray(allowed) && allowed.length ? allowed[0] : apiBase;
  const finalUrl = `${targetOrigin}/`;

  const manifest = {
    manifestVersion: '1.0',
    jobId,
    bountyId,
    finalUrl, // default to the job's first allowed origin
    worker: {
      workerId: me.json.workerId,
      skillVersion: '1.0.0',
      fingerprint: { fingerprintClass: lastClaim?.data?.job?.environment?.fingerprintClass || 'unknown' },
    },
    result: {
      outcome: 'failure',
      failureType: 'blocker',
      severity: 'high',
      expected,
      observed,
      reproConfidence: 'high',
    },
    reproSteps: steps.length ? steps : ['repro'],
    artifacts: [lastArtifact],
    suggestedChange: { type: 'bugfix', text: 'Fix the issue' },
  };

  const { res, json } = await api(`/api/jobs/${jobId}/submit`, { method: 'POST', token, body: { manifest, artifactIndex: [lastArtifact] } });
  $('submitOut').textContent = pretty(json);
  if (!res.ok) {
    setStatus('submitStatus', `submit failed (${res.status})`, 'bad');
    return;
  }
  setStatus('submitStatus', `state=${json.state}`, 'good');
}

async function onListPayouts() {
  setStatus('payoutStatusMsg', '', null);
  const token = requireTokenUI();
  const status = $('payoutStatus').value.trim();
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  const { res, json } = await api(`/api/worker/payouts?${qs.toString()}`, { token });
  $('payoutOut').textContent = pretty(json);
  if (!res.ok) {
    setStatus('payoutStatusMsg', `list payouts failed (${res.status})`, 'bad');
    return;
  }
  setStatus('payoutStatusMsg', `ok (${json.payouts?.length ?? 0} payouts)`, 'good');
}

async function onPayoutMessage() {
  setStatus('payoutAddrStatus', '', null);
  const token = requireTokenUI();
  const chain = $('payoutChain').value || 'base';
  const address = $('payoutAddress').value.trim();
  if (!address) {
    setStatus('payoutAddrStatus', 'Missing payout address', 'bad');
    return;
  }

  const { res, json } = await api('/api/worker/payout-address/message', { method: 'POST', token, body: { chain, address } });
  $('payoutMessage').textContent = String(json?.message ?? '');
  if (!res.ok) {
    setStatus('payoutAddrStatus', `message failed (${res.status})`, 'bad');
    return;
  }
  if (json?.address) $('payoutAddress').value = String(json.address);
  setStatus('payoutAddrStatus', 'message ok (sign it and paste signature below)', 'good');
}

async function onSetPayoutAddress() {
  setStatus('payoutAddrStatus', '', null);
  const token = requireTokenUI();
  const chain = $('payoutChain').value || 'base';
  const address = $('payoutAddress').value.trim();
  const signature = $('payoutSignature').value.trim();
  if (!address) return setStatus('payoutAddrStatus', 'Missing payout address', 'bad');
  if (!signature) return setStatus('payoutAddrStatus', 'Missing signature', 'bad');

  const { res, json } = await api('/api/worker/payout-address', { method: 'POST', token, body: { chain, address, signature } });
  if (!res.ok) {
    $('payoutMessage').textContent = pretty(json);
    setStatus('payoutAddrStatus', `verify failed (${res.status})`, 'bad');
    return;
  }
  setStatus('payoutAddrStatus', 'verified', 'good');
}

$('btnRegister').addEventListener('click', () => onRegister().catch((e) => setStatus('authStatus', String(e), 'bad')));
$('btnSaveToken').addEventListener('click', () => onSaveToken());
$('btnMe').addEventListener('click', () => onMe().catch((e) => setStatus('authStatus', String(e), 'bad')));
$('btnNext').addEventListener('click', () => onNext().catch((e) => setStatus('jobStatus', String(e), 'bad')));
$('btnClaim').addEventListener('click', () => onClaim().catch((e) => setStatus('jobStatus', String(e), 'bad')));
$('btnUpload').addEventListener('click', () => onUpload().catch((e) => setStatus('uploadStatus', String(e), 'bad')));
$('btnSubmit').addEventListener('click', () => onSubmit().catch((e) => setStatus('submitStatus', String(e), 'bad')));
$('btnPayoutMessage').addEventListener('click', () => onPayoutMessage().catch((e) => setStatus('payoutAddrStatus', String(e), 'bad')));
$('btnSetPayoutAddress').addEventListener('click', () => onSetPayoutAddress().catch((e) => setStatus('payoutAddrStatus', String(e), 'bad')));
$('btnListPayouts').addEventListener('click', () => onListPayouts().catch((e) => setStatus('payoutStatusMsg', String(e), 'bad')));

// Init
setToken(getToken());
