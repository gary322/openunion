const apiBase = window.location.origin;

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
  return localStorage.getItem('pw_admin_token') || '';
}

function setToken(token) {
  localStorage.setItem('pw_admin_token', token);
  $('adminToken').value = token;
}

async function api(path, { method = 'POST', token, body } = {}) {
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

function requireToken() {
  const t = $('adminToken').value.trim();
  if (!t) throw new Error('missing admin token');
  return t;
}

function onSave() {
  const t = $('adminToken').value.trim();
  if (!t) return setStatus('authStatus', 'missing token', 'bad');
  setToken(t);
  setStatus('authStatus', 'token saved', 'good');
}

async function onBan() {
  setStatus('workerStatus', '', null);
  const token = requireToken();
  const workerId = $('workerId').value.trim();
  const { res, json } = await api(`/api/admin/workers/${encodeURIComponent(workerId)}/ban`, { method: 'POST', token });
  $('workerOut').textContent = pretty(json);
  if (!res.ok) return setStatus('workerStatus', `ban failed (${res.status})`, 'bad');
  setStatus('workerStatus', 'banned', 'good');
}

async function onRateLimit() {
  setStatus('workerStatus', '', null);
  const token = requireToken();
  const workerId = $('workerId').value.trim();
  const durationSec = Number($('durationSec').value);
  const { res, json } = await api(`/api/admin/workers/${encodeURIComponent(workerId)}/rate-limit`, { method: 'POST', token, body: { durationSec } });
  $('workerOut').textContent = pretty(json);
  if (!res.ok) return setStatus('workerStatus', `rate-limit failed (${res.status})`, 'bad');
  setStatus('workerStatus', 'ok', 'good');
}

async function onRequeue() {
  setStatus('verStatus', '', null);
  const token = requireToken();
  const verificationId = $('verificationId').value.trim();
  const { res, json } = await api(`/api/admin/verifications/${encodeURIComponent(verificationId)}/requeue`, { method: 'POST', token });
  $('verOut').textContent = pretty(json);
  if (!res.ok) return setStatus('verStatus', `requeue failed (${res.status})`, 'bad');
  setStatus('verStatus', 'ok', 'good');
}

async function onMarkDup() {
  setStatus('subStatus', '', null);
  const token = requireToken();
  const submissionId = $('submissionId').value.trim();
  const { res, json } = await api(`/api/admin/submissions/${encodeURIComponent(submissionId)}/mark-duplicate`, { method: 'POST', token });
  $('subOut').textContent = pretty(json);
  if (!res.ok) return setStatus('subStatus', `mark-duplicate failed (${res.status})`, 'bad');
  setStatus('subStatus', 'ok', 'good');
}

async function onOverride() {
  setStatus('subStatus', '', null);
  const token = requireToken();
  const submissionId = $('submissionId').value.trim();
  const verdict = $('verdict').value;
  const qualityScore = Number($('qualityScore').value);
  const { res, json } = await api(`/api/admin/submissions/${encodeURIComponent(submissionId)}/override-verdict`, {
    method: 'POST',
    token,
    body: { verdict, qualityScore },
  });
  $('subOut').textContent = pretty(json);
  if (!res.ok) return setStatus('subStatus', `override failed (${res.status})`, 'bad');
  setStatus('subStatus', 'ok', 'good');
}

$('btnSave').addEventListener('click', () => onSave());
$('btnBan').addEventListener('click', () => onBan().catch((e) => setStatus('workerStatus', String(e), 'bad')));
$('btnRateLimit').addEventListener('click', () => onRateLimit().catch((e) => setStatus('workerStatus', String(e), 'bad')));
$('btnRequeue').addEventListener('click', () => onRequeue().catch((e) => setStatus('verStatus', String(e), 'bad')));
$('btnMarkDup').addEventListener('click', () => onMarkDup().catch((e) => setStatus('subStatus', String(e), 'bad')));
$('btnOverride').addEventListener('click', () => onOverride().catch((e) => setStatus('subStatus', String(e), 'bad')));

setToken(getToken());

