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

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${apiBase}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
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

async function onList() {
  setStatus('listStatus', '', null);
  const token = requireToken();
  const status = $('statusFilter').value.trim();
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  const { res, json } = await api(`/api/admin/disputes?${qs.toString()}`, { method: 'GET', token });
  $('out').textContent = pretty(json);
  if (!res.ok) return setStatus('listStatus', `list failed (${res.status})`, 'bad');
  setStatus('listStatus', `ok (${json.disputes?.length ?? 0} disputes)`, 'good');
}

async function onResolve() {
  setStatus('resolveStatus', '', null);
  const token = requireToken();
  const disputeId = $('disputeId').value.trim();
  if (!disputeId) return setStatus('resolveStatus', 'missing disputeId', 'bad');
  const resolution = $('resolution').value;
  const notes = $('notes').value.trim() || null;
  const { res, json } = await api(`/api/admin/disputes/${encodeURIComponent(disputeId)}/resolve`, {
    method: 'POST',
    token,
    body: { resolution, notes },
  });
  $('out').textContent = pretty(json);
  if (!res.ok) return setStatus('resolveStatus', `resolve failed (${res.status})`, 'bad');
  setStatus('resolveStatus', 'ok', 'good');
}

$('btnSave').addEventListener('click', () => onSave());
$('btnList').addEventListener('click', () => onList().catch((e) => setStatus('listStatus', String(e), 'bad')));
$('btnResolve').addEventListener('click', () => onResolve().catch((e) => setStatus('resolveStatus', String(e), 'bad')));

setToken(getToken());

