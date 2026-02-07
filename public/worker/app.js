import { LS, copyToClipboard, formatAgo, formatCents, startPolling, storageGet, storageSet, toast } from '/ui/pw.js';

const apiBase = window.location.origin;
document.getElementById('apiBase').textContent = apiBase;

function $(id) {
  return document.getElementById(id);
}

let actionbarHandler = null;
let cachedPayoutOk = false;

// Mark folds as "user toggled" so guided auto-open logic doesn't fight manual intent.
for (const summary of Array.from(document.querySelectorAll('details.pw-fold > summary'))) {
  summary.addEventListener('click', (ev) => {
    const d = ev.currentTarget?.parentElement;
    if (d && String(d.tagName || '').toLowerCase() === 'details') {
      try {
        d.dataset.userToggled = '1';
      } catch {
        // ignore
      }
    }
  });
}

function setPill(id, text, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = String(text ?? '');
  el.classList.remove('good', 'warn', 'faint');
  if (kind) el.classList.add(kind);
}

function setFoldOpen(id, open, opts = {}) {
  const el = $(id);
  if (!el) return;
  const force = Boolean(opts && opts.force);
  if (!force && String(el.dataset?.userToggled ?? '') === '1') return;
  try {
    el.open = Boolean(open);
  } catch {
    // ignore
  }
}

function openOnlyFold(focusId) {
  // "Only" is aspirational: we avoid auto-closing other sections because it can hide controls
  // mid-flow (low trust UX). Instead, always open the recommended fold.
  setFoldOpen(focusId, true);
}

function scrollToAnchor(id) {
  const el = document.getElementById(String(id || '').replace(/^#/, ''));
  if (!el) return;
  if (String(el.tagName || '').toLowerCase() === 'details') {
    // If the anchor is a fold, open it so the user doesn't scroll to hidden content.
    try {
      el.open = true;
    } catch {
      // ignore
    }
  }
  try {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch {
    el.scrollIntoView();
  }
}

function setActionbar({ title, sub, label, onClick }) {
  const t = $('workerActionbarTitle');
  const s = $('workerActionbarSub');
  const b = $('btnWorkerActionbar');
  if (t) t.textContent = String(title || '');
  if (s) s.textContent = String(sub || '');
  if (b) b.textContent = String(label || 'Go');
  actionbarHandler = typeof onClick === 'function' ? onClick : null;
}

function updateActionbar() {
  const btn = $('btnWorkerActionbar');
  if (!btn) return;

  const token = $('token')?.value?.trim?.() || getToken();
  const hasToken = Boolean(String(token || '').trim());
  const hasJob = Boolean(lastClaim?.data?.job?.jobId || lastNext?.data?.job?.jobId);

  setPill('pillAuth', hasToken ? 'Connected' : 'Not connected', hasToken ? 'good' : 'warn');
  setPill('pillPayouts', cachedPayoutOk ? 'Verified' : 'Not set', cachedPayoutOk ? 'good' : 'warn');

  if (!hasJob) setPill('pillJob', 'No job', 'faint');
  else setPill('pillJob', 'Job loaded', 'good');

  // Keep key workflow sections discoverable by default. We guide via actionbar, but we don't
  // hide the work surface.
  if (hasToken) setFoldOpen('find', true);
  if (hasToken && !cachedPayoutOk) setFoldOpen('payouts', true);
  if (hasJob && !canSubmitNow()) setFoldOpen('outputs', true);
  if (hasJob && canSubmitNow()) setFoldOpen('submit', true);

  if (requiredSlots.length) {
    const done = requiredSlots.filter((s) => s.scanStatus === 'scanned' || s.scanStatus === 'accepted').length;
    const blocked = requiredSlots.filter((s) => s.scanStatus === 'blocked').length;
    const total = requiredSlots.length;
    setPill('pillOutputs', blocked ? `Blocked ${blocked}` : `Ready ${done}/${total}`, blocked ? 'warn' : done === total ? 'good' : 'faint');
  } else {
    setPill('pillOutputs', hasJob ? 'Waiting' : 'Waiting', 'faint');
  }
  setPill('pillSubmit', canSubmitNow() ? 'Ready' : 'Locked', canSubmitNow() ? 'good' : 'faint');
  setPill('pillFind', !hasToken ? 'Locked' : hasJob ? 'Done' : 'Ready', !hasToken ? 'warn' : hasJob ? 'faint' : 'good');

  if (!hasToken) {
    setActionbar({
      title: 'Next: get a worker token',
      sub: 'Register once or paste a token. We store it locally in your browser.',
      label: 'Set up',
      onClick: () => scrollToAnchor('auth'),
    });
    openOnlyFold('auth');
    return;
  }

  if (!cachedPayoutOk) {
    setActionbar({
      title: 'Next: verify payout address',
      sub: 'Set a payout address on Base once so you can be paid automatically.',
      label: 'Verify',
      onClick: () => scrollToAnchor('payouts'),
    });
    openOnlyFold('payouts');
    return;
  }

  if (!hasJob) {
    setActionbar({
      title: 'Next: claim a job',
      sub: 'We will pick the next compatible job based on your capabilities and filters.',
      label: 'Claim next',
      onClick: () => {
        scrollToAnchor('find');
        onClaimNext().catch((e) => setStatus('jobStatus', String(e), 'bad'));
      },
    });
    openOnlyFold('find');
    return;
  }

  if (!canSubmitNow()) {
    setActionbar({
      title: 'Next: upload required outputs',
      sub: 'Drop files to upload, or upload one output at a time. Submit unlocks when scans pass.',
      label: 'Upload',
      onClick: () => scrollToAnchor('outputs'),
    });
    openOnlyFold('outputs');
    return;
  }

  setActionbar({
    title: 'Ready: submit',
    sub: 'All required outputs are uploaded and scanned. Submit to get paid after the hold window.',
    label: 'Submit',
    onClick: () => scrollToAnchor('submit'),
  });
  openOnlyFold('submit');
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
  return storageGet(LS.workerToken, '');
}

function setToken(token) {
  storageSet(LS.workerToken, token);
  $('token').value = token;
}

function setBadge(id, text) {
  const el = $(id);
  if (!el) return;
  el.textContent = String(text ?? '');
}

function setStepDone(id, done) {
  const el = $(id);
  if (!el) return;
  el.classList.toggle('done', Boolean(done));
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
let extraArtifacts = [];

let requiredSlots = [];
let activeSlotIdx = null;
let scanPollTimers = new Map();

async function refreshReadyStatus() {
  const token = $('token').value.trim() || getToken();
  const hasToken = Boolean(token);
  setStepDone('stepWorkerToken', hasToken);

  let payoutOk = false;
  if (hasToken) {
    try {
      const me = await api('/api/worker/me', { token });
      payoutOk = Boolean(me.res.ok && me.json?.payout?.verifiedAt);
    } catch {
      payoutOk = false;
    }
  }

  cachedPayoutOk = payoutOk;
  setStepDone('stepWorkerPayout', payoutOk);
  const remaining = (hasToken ? 0 : 1) + (payoutOk ? 0 : 1);
  setBadge('navBadgeReady', String(remaining));
  updateActionbar();
}

function currentJobEnvelope() {
  return lastClaim || lastNext;
}

function currentJobSpec() {
  return currentJobEnvelope()?.data?.job || null;
}

function setJobSummary(text) {
  const el = $('jobSummary');
  if (!el) return;
  el.textContent = String(text ?? '');
}

function clearScanPoll(slotId) {
  const t = scanPollTimers.get(slotId);
  if (t) clearTimeout(t);
  scanPollTimers.delete(slotId);
}

function clearAllScanPolls() {
  for (const k of Array.from(scanPollTimers.keys())) clearScanPoll(k);
}

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

function expandRequiredArtifactSpecs(requiredArtifacts) {
  const slots = [];
  const specs = Array.isArray(requiredArtifacts) ? requiredArtifacts : [];
  for (const spec of specs) {
    const kind = String(spec?.kind ?? '').trim();
    if (!kind) continue;
    const count = Number.isFinite(Number(spec?.count)) ? Math.max(1, Math.min(20, Number(spec.count))) : 1;
    for (let i = 1; i <= count; i++) {
      const label =
        String(spec?.label ?? '').trim() ||
        (String(spec?.label_prefix ?? '').trim()
          ? count > 1
            ? `${String(spec.label_prefix).trim()}-${i}`
            : String(spec.label_prefix).trim()
          : count > 1
            ? `${kind}-${i}`
            : kind);
      slots.push({
        id: `${kind}:${label}:${i}:${Math.random().toString(16).slice(2)}`,
        kind,
        label,
        artifactId: null,
        ref: null,
        scanStatus: null,
        scanReason: null,
      });
    }
  }
  return slots;
}

function buildRequiredOutputsFromJob() {
  clearAllScanPolls();
  requiredSlots = [];
  activeSlotIdx = null;

  const spec = currentJobSpec();
  const td = spec?.taskDescriptor;
  const required = td?.output_spec?.required_artifacts;
  const slots = expandRequiredArtifactSpecs(required);
  requiredSlots = slots;
  renderRequiredOutputs();
  updateActionbar();
}

function renderRequiredOutputs() {
  const wrap = $('requiredOutputs');
  const status = $('requiredOutputsStatus');
  if (!wrap || !status) return;

  if (!requiredSlots.length) {
    const adv = $('advancedUploads');
    if (adv) adv.open = true;
    wrap.innerHTML =
      '<div class="pw-muted">No structured output requirements found for this job. Use "Advanced: upload extra artifacts" or follow the job spec.</div>';
    status.textContent = '';
    updateSubmitEnabled();
    return;
  }

  const adv = $('advancedUploads');
  if (adv) adv.open = false;

  const cards = requiredSlots
    .map((s, idx) => {
      const scan = String(s.scanStatus ?? 'pending');
      const reason = s.scanReason ? ` (${String(s.scanReason).slice(0, 90)})` : '';
      const actionLabel = s.ref ? 'Replace file' : 'Upload file';
      const pillKind =
        s.scanStatus === 'blocked'
          ? 'warn'
          : s.scanStatus === 'scanned' || s.scanStatus === 'accepted'
            ? 'good'
            : 'faint';
      const title = `${String(s.kind || '')}`.trim() || 'output';
      return `
        <article class="pw-card soft pw-output-card">
          <div class="pw-card-title">
            <h3>${escapeHtml(title)}</h3>
            <span class="pw-pill ${pillKind}">${escapeHtml(scan)}</span>
          </div>
          <div class="pw-muted">${escapeHtml(s.label)}${escapeHtml(reason)}</div>
          <div class="pw-actions">
            <button class="pw-btn" data-slot="${idx}">${escapeHtml(actionLabel)}</button>
          </div>
        </article>
      `;
    })
    .join('');

  wrap.innerHTML = `
    <div class="pw-dropzone" id="dropzone" role="button" tabindex="0" aria-label="Drop files to upload">
      <div class="pw-kicker">Drop files</div>
      <div class="pw-muted">Attach files to required outputs in order. Or use "Upload file" on a specific output.</div>
    </div>
    <div class="pw-template-grid" aria-label="Required outputs">${cards}</div>
  `;

  // Dropzone: sequentially fills the next uploadable slot(s).
  const dz = $('dropzone');
  if (dz) {
    const setOver = (on) => dz.classList.toggle('dragover', Boolean(on));
    dz.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      setOver(true);
    });
    dz.addEventListener('dragleave', () => setOver(false));
    dz.addEventListener('drop', (ev) => {
      ev.preventDefault();
      setOver(false);
      const files = Array.from(ev.dataTransfer?.files ?? []);
      if (!files.length) return;
      uploadFilesToNextSlots(files).catch((err) => {
        setStatus('requiredOutputsStatus', String(err?.message ?? err), 'bad');
      });
    });
    dz.addEventListener('click', () => {
      const idx = nextUploadableSlotIndex(0);
      if (idx === null || idx === undefined) return;
      activeSlotIdx = idx;
      const f = $('slotFile');
      if (f) {
        f.value = '';
        f.click();
      }
    });
    dz.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      dz.click();
    });
  }

  const done = requiredSlots.filter((s) => s.scanStatus === 'scanned' || s.scanStatus === 'accepted').length;
  const blocked = requiredSlots.filter((s) => s.scanStatus === 'blocked').length;
  const total = requiredSlots.length;
  status.textContent = blocked ? `Blocked: ${blocked}. Ready: ${done}/${total}.` : `Ready: ${done}/${total}.`;

  updateSubmitEnabled();
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function canSubmitNow() {
  if (!requiredSlots.length) return Boolean(lastArtifact || extraArtifacts.length);
  return requiredSlots.every((s) => s.scanStatus === 'scanned' || s.scanStatus === 'accepted');
}

function updateSubmitEnabled() {
  const btn = $('btnSubmit');
  if (!btn) return;
  btn.disabled = !canSubmitNow();
  updateActionbar();
}

function nextUploadableSlotIndex(startIdx) {
  const start = Number.isFinite(Number(startIdx)) ? Math.max(0, Math.floor(Number(startIdx))) : 0;
  for (let i = start; i < requiredSlots.length; i++) {
    const s = requiredSlots[i];
    if (!s) continue;
    if (s.scanStatus === 'scanned' || s.scanStatus === 'accepted') continue;
    return i;
  }
  return null;
}

async function uploadFilesToNextSlots(files) {
  const list = Array.from(files || []);
  if (!list.length) return;
  let cursor = 0;
  for (const file of list) {
    const idx = nextUploadableSlotIndex(cursor);
    if (idx === null) break;
    const slot = requiredSlots[idx];
    setStatus('requiredOutputsStatus', `Uploading ${file.name} → ${slot.kind}/${slot.label}`, null);
    await uploadFileForSlot(idx, file);
    cursor = idx + 1;
  }
  renderRequiredOutputs();
}

async function fetchArtifactStatus(token, artifactId) {
  const { res, json } = await api(`/api/artifacts/${encodeURIComponent(artifactId)}`, { token });
  if (!res.ok) return { status: null, reason: null };
  return { status: json?.status ?? null, reason: json?.scanReason ?? null };
}

async function pollSlotStatus(slotIdx) {
  const token = requireTokenUI();
  const slot = requiredSlots[slotIdx];
  if (!slot || !slot.artifactId) return;

  clearScanPoll(slot.id);
  const tick = async () => {
    try {
      const { status, reason } = await fetchArtifactStatus(token, slot.artifactId);
      if (status) {
        slot.scanStatus = status;
        slot.scanReason = reason;
        renderRequiredOutputs();
      }
      if (status === 'scanned' || status === 'accepted' || status === 'blocked') {
        clearScanPoll(slot.id);
        return;
      }
    } catch {
      // ignore
    }
    const t = setTimeout(tick, 1200);
    scanPollTimers.set(slot.id, t);
  };
  const t = setTimeout(tick, 200);
  scanPollTimers.set(slot.id, t);
}

async function uploadFileForSlot(slotIdx, file) {
  const token = requireTokenUI();
  const jobId = requireJobIdUI();
  const slot = requiredSlots[slotIdx];
  if (!slot) throw new Error('invalid slot');

  const { res: presRes, json: presJson } = await api('/api/uploads/presign', {
    method: 'POST',
    token,
    body: {
      jobId,
      files: [{ filename: file.name, contentType: file.type || 'application/octet-stream', sizeBytes: file.size }],
    },
  });
  if (!presRes.ok) throw new Error(`presign failed (${presRes.status})`);

  const upload = presJson.uploads[0];
  const putHeaders = { ...(upload.headers || {}) };
  if (String(upload.url || '').includes('/api/uploads/local/')) {
    putHeaders['Authorization'] = `Bearer ${token}`;
  }
  const putRes = await fetch(upload.url, { method: 'PUT', headers: putHeaders, body: file });
  if (!putRes.ok) throw new Error(`upload failed (${putRes.status})`);

  const sha = await sha256Hex(file);
  try {
    await api('/api/uploads/complete', { method: 'POST', token, body: { artifactId: upload.artifactId, sha256: sha, sizeBytes: file.size } });
  } catch {
    // ignore
  }

  const ref = {
    kind: slot.kind,
    label: slot.label,
    sha256: sha,
    url: upload.finalUrl,
    sizeBytes: file.size,
    contentType: file.type || 'application/octet-stream',
  };

  slot.artifactId = upload.artifactId;
  slot.ref = ref;
  slot.scanStatus = 'uploaded';
  slot.scanReason = null;
  renderRequiredOutputs();
  await pollSlotStatus(slotIdx);
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
  refreshReadyStatus().catch(() => {});
}

async function onSaveToken() {
  setStatus('authStatus', '', null);
  const token = $('token').value.trim();
  if (!token) return setStatus('authStatus', 'Missing token', 'bad');
  setToken(token);
  setStatus('authStatus', 'Token saved', 'good');
  refreshReadyStatus().catch(() => {});
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
  refreshReadyStatus().catch(() => {});
}

async function onNext() {
  setStatus('jobStatus', '', null);
  const token = requireTokenUI();
  const qs = new URLSearchParams();
  const minPayout = $('minPayoutCents')?.value?.trim?.() || '';
  const capTag = $('capabilityTag')?.value?.trim?.() || '';
  if (minPayout) qs.set('min_payout_cents', minPayout);
  if (capTag) qs.set('capability_tag', capTag);
  const path = qs.toString() ? `/api/jobs/next?${qs.toString()}` : '/api/jobs/next';
  const { res, json } = await api(path, { token });
  lastNext = json;
  lastClaim = null;
  $('jobOut').textContent = pretty(json);
  if (!res.ok) {
    setStatus('jobStatus', `jobs/next failed (${res.status})`, 'bad');
    return;
  }
  setStatus('jobStatus', `state=${json.state}`, 'good');
  const spec = json?.data?.job;
  if (json?.state === 'claimable' && spec?.title) setJobSummary(`Loaded: ${spec.title}. Claim it to start.`);
  else if (json?.state === 'idle') setJobSummary('No jobs available right now.');
  else setJobSummary(`State: ${String(json?.state ?? '')}`);
  buildRequiredOutputsFromJob();
}

async function onClaimNext() {
  setStatus('jobStatus', '', null);
  setJobSummary('Finding the next job…');
  await onNext();
  if (lastNext?.state !== 'claimable') return;
  await onClaim();
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
  const spec = json?.data?.job;
  if (spec?.title) setJobSummary(`Active: ${spec.title}. Upload required outputs, then submit.`);
  buildRequiredOutputsFromJob();
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
  extraArtifacts.push(lastArtifact);

  $('artifactOut').textContent = pretty(lastArtifact);
  setStatus('uploadStatus', `uploaded artifactId=${upload.artifactId}`, 'good');
  updateSubmitEnabled();
}

async function onSubmit() {
  setStatus('submitStatus', '', null);
  const token = requireTokenUI();
  const jobId = requireJobIdUI();
  const bountyId = requireBountyIdUI();

  if (!canSubmitNow()) {
    setStatus('submitStatus', 'Upload all required outputs (and wait for scan) before submitting', 'bad');
    return;
  }

  const artifacts = [
    ...requiredSlots.map((s) => s.ref).filter(Boolean),
    ...extraArtifacts,
  ].filter(Boolean);
  if (!artifacts.length) {
    setStatus('submitStatus', 'Upload at least one artifact first', 'bad');
    return;
  }

  const me = await api('/api/worker/me', { token });
  if (!me.res.ok) {
    setStatus('submitStatus', `worker/me failed (${me.res.status})`, 'bad');
    return;
  }

  const summary = String($('summary')?.value ?? '').trim();
  const expectedRaw = String($('expected')?.value ?? '').trim();
  const observedRaw = String($('observed')?.value ?? '').trim();
  const stepsRaw = String($('steps')?.value ?? '');

  const expected = expectedRaw || 'Expected deliverables';
  const observed = observedRaw || summary || 'Attached deliverables';
  let steps = stepsRaw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!steps.length) {
    steps = (summary ? summary.split('\n') : [])
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (!steps.length) {
    steps = ['Completed the requested task', 'Uploaded required artifacts'];
  }

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
    artifacts,
    suggestedChange: { type: 'bugfix', text: 'Fix the issue' },
  };

  const { res, json } = await api(`/api/jobs/${jobId}/submit`, { method: 'POST', token, body: { manifest, artifactIndex: artifacts } });
  $('submitOut').textContent = pretty(json);
  if (!res.ok) {
    setStatus('submitStatus', `submit failed (${res.status})`, 'bad');
    return;
  }
  setStatus('submitStatus', `state=${json.state}`, 'good');
}

async function onListPayouts() {
  return onListPayoutsInternal({ silent: false });
}

let payoutsAutoOn = true;
let payoutsPollPrimed = false;
let stopPayoutsPoll = null;

function setPayoutsAutoUi() {
  const btn = $('btnPayoutsAutoRefresh');
  if (!btn) return;
  btn.setAttribute('aria-pressed', payoutsAutoOn ? 'true' : 'false');
  btn.textContent = payoutsAutoOn ? 'Auto-refresh' : 'Auto-refresh (off)';
}

function stopPayoutPolling() {
  if (stopPayoutsPoll) stopPayoutsPoll();
  stopPayoutsPoll = null;
}

function maybeStartPayoutPolling() {
  if (!payoutsAutoOn) return;
  if (!payoutsPollPrimed) return;
  if (stopPayoutsPoll) return;
  stopPayoutsPoll = startPolling(() => onListPayoutsInternal({ silent: true }), { intervalMs: 5000, immediate: false });
}

function formatHoldCountdown(holdUntilMs) {
  const hu = Number(holdUntilMs ?? 0);
  if (!Number.isFinite(hu) || hu <= 0) return '-';
  const delta = hu - Date.now();
  if (delta <= 0) return 'released';
  const s = Math.floor(delta / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `in ${h}h`;
  const d = Math.floor(h / 24);
  return `in ${d}d`;
}

function payoutStatusClass(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'paid') return 'good';
  if (s === 'failed') return 'bad';
  if (s === 'refunded' || s === 'reversed') return 'warn';
  return '';
}

function renderWorkerPayoutRows(payouts) {
  const tbody = $('workerPayoutRows');
  if (!tbody) return;
  const rows = Array.isArray(payouts) ? payouts : [];
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="pw-muted">No payouts yet.</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map((p) => {
      const when = p?.createdAt ? formatAgo(p.createdAt) : '-';
      const status = String(p?.status ?? '');
      const statusCls = payoutStatusClass(status);
      const net = p?.netAmountCents !== null && p?.netAmountCents !== undefined ? formatCents(p.netAmountCents) : '-';
      const pf = p?.platformFeeCents !== null && p?.platformFeeCents !== undefined ? formatCents(p.platformFeeCents) : '-';
      const pwf = p?.proofworkFeeCents !== null && p?.proofworkFeeCents !== undefined ? formatCents(p.proofworkFeeCents) : '-';
      const hold = formatHoldCountdown(p?.holdUntil);
      const blocked = String(p?.blockedReason ?? '').trim();
      const provider = String(p?.provider ?? '').trim() || '-';
      const pref = String(p?.providerRef ?? '').trim();
      const bounty = String(p?.bountyTitle ?? '').trim() || (p?.bountyId ? String(p.bountyId) : '-');
      const taskType = String(p?.taskType ?? '').trim();
      const id = String(p?.id ?? '').trim();

      const providerText = pref ? `${provider} - ${pref}` : provider;
      const holdText = blocked ? `${hold} - blocked: ${blocked}` : hold;

      return `
        <tr>
          <td title="${escapeHtml(p?.createdAt ? new Date(p.createdAt).toISOString() : '')}">${escapeHtml(when)}</td>
          <td><span class="pw-chip ${escapeHtml(statusCls)}">${escapeHtml(status || '-')}</span></td>
          <td class="pw-mono">${escapeHtml(net)}</td>
          <td class="pw-mono">Platform ${escapeHtml(pf)} + PW ${escapeHtml(pwf)}</td>
          <td>${escapeHtml(holdText)}</td>
          <td class="pw-mono" title="${escapeHtml(providerText)}">${escapeHtml(providerText.slice(0, 48))}${providerText.length > 48 ? '...' : ''}</td>
          <td title="${escapeHtml(taskType)}">${escapeHtml(bounty)}${taskType ? ` <span class="pw-muted pw-mono">(${escapeHtml(taskType)})</span>` : ''}</td>
          <td>
            ${id ? `<button class="pw-btn" type="button" data-copy-payout-id="${escapeHtml(id)}">Copy id</button>` : ''}
          </td>
        </tr>
      `;
    })
    .join('');
}

async function onListPayoutsInternal({ silent }) {
  if (!silent) setStatus('payoutStatusMsg', '', null);
  const token = requireTokenUI();
  const status = $('payoutStatus').value.trim();
  const page = $('payoutPage')?.value?.trim?.() || '';
  const limit = $('payoutLimit')?.value?.trim?.() || '';

  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (page) qs.set('page', page);
  if (limit) qs.set('limit', limit);

  const path = qs.toString() ? `/api/worker/payouts?${qs.toString()}` : '/api/worker/payouts';
  const { res, json } = await api(path, { token });
  $('payoutOut').textContent = pretty(json);
  if (!res.ok) {
    if (!silent) setStatus('payoutStatusMsg', `list payouts failed (${res.status})`, 'bad');
    renderWorkerPayoutRows([]);
    return;
  }

  payoutsPollPrimed = true;
  renderWorkerPayoutRows(json?.payouts ?? []);
  maybeStartPayoutPolling();

  if (!silent) setStatus('payoutStatusMsg', `ok (${json.payouts?.length ?? 0} payouts)`, 'good');
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
  refreshReadyStatus().catch(() => {});
}

$('btnRegister').addEventListener('click', () => onRegister().catch((e) => setStatus('authStatus', String(e), 'bad')));
$('btnSaveToken').addEventListener('click', () => onSaveToken());
$('btnMe').addEventListener('click', () => onMe().catch((e) => setStatus('authStatus', String(e), 'bad')));
$('btnWorkerActionbar')?.addEventListener('click', () => {
  try {
    actionbarHandler?.();
  } catch {
    // ignore
  }
});
$('btnCopyWorkerToken').addEventListener('click', async () => {
  const token = $('token').value.trim() || getToken();
  if (!token) {
    toast('Missing token', 'bad');
    return;
  }
  await copyToClipboard(token);
});
$('btnClaimNext')?.addEventListener('click', () => onClaimNext().catch((e) => setStatus('jobStatus', String(e), 'bad')));
$('btnNext').addEventListener('click', () => onNext().catch((e) => setStatus('jobStatus', String(e), 'bad')));
$('btnClaim').addEventListener('click', () => onClaim().catch((e) => setStatus('jobStatus', String(e), 'bad')));
$('btnUpload').addEventListener('click', () => onUpload().catch((e) => setStatus('uploadStatus', String(e), 'bad')));
$('btnSubmit').addEventListener('click', () => onSubmit().catch((e) => setStatus('submitStatus', String(e), 'bad')));
$('btnPayoutMessage').addEventListener('click', () => onPayoutMessage().catch((e) => setStatus('payoutAddrStatus', String(e), 'bad')));
$('btnSetPayoutAddress').addEventListener('click', () => onSetPayoutAddress().catch((e) => setStatus('payoutAddrStatus', String(e), 'bad')));
$('btnListPayouts').addEventListener('click', () => onListPayouts().catch((e) => setStatus('payoutStatusMsg', String(e), 'bad')));
const btnPayoutsAuto = $('btnPayoutsAutoRefresh');
if (btnPayoutsAuto) {
  setPayoutsAutoUi();
  btnPayoutsAuto.addEventListener('click', () => {
    payoutsAutoOn = !payoutsAutoOn;
    setPayoutsAutoUi();
    if (!payoutsAutoOn) {
      stopPayoutPolling();
      toast('Auto-refresh off');
    } else {
      maybeStartPayoutPolling();
      toast('Auto-refresh on', 'good');
    }
  });
}

// Required outputs: event delegation for per-slot uploads.
const reqWrap = $('requiredOutputs');
if (reqWrap) {
  reqWrap.addEventListener('click', (ev) => {
    const target = ev.target;
    const btn = target && typeof target.closest === 'function' ? target.closest('button[data-slot]') : null;
    if (!btn) return;
    const idx = Number(btn.getAttribute('data-slot'));
    if (!Number.isFinite(idx)) return;
    activeSlotIdx = idx;
    const f = $('slotFile');
    if (f) {
      f.value = '';
      f.click();
    }
  });
}

const slotFile = $('slotFile');
if (slotFile) {
  slotFile.addEventListener('change', async () => {
    if (activeSlotIdx === null || activeSlotIdx === undefined) return;
    const file = slotFile.files?.[0];
    if (!file) return;
    try {
      setStatus('requiredOutputsStatus', 'Uploading...', null);
      await uploadFileForSlot(activeSlotIdx, file);
      setStatus('requiredOutputsStatus', 'Uploaded. Waiting for scan...', 'good');
    } catch (err) {
      setStatus('requiredOutputsStatus', String(err?.message ?? err), 'bad');
    } finally {
      activeSlotIdx = null;
      // Render may have overwritten status; keep submit button in sync.
      updateSubmitEnabled();
    }
  });
}

// Init
setToken(getToken());
refreshReadyStatus().catch(() => {});
buildRequiredOutputsFromJob();
renderWorkerPayoutRows([]);

// Worker payouts table: event delegation for copy actions.
const payoutTbody = $('workerPayoutRows');
if (payoutTbody) {
  payoutTbody.addEventListener('click', (ev) => {
    const target = ev.target;
    const btn = target && typeof target.closest === 'function' ? target.closest('button[data-copy-payout-id]') : null;
    if (!btn) return;
    const id = btn.getAttribute('data-copy-payout-id') || '';
    if (!id) return;
    copyToClipboard(id).catch(() => {});
  });
}
