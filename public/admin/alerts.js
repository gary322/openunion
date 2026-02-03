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
  const env = $('envFilter').value.trim();
  const alarmName = $('alarmFilter').value.trim();
  const qs = new URLSearchParams();
  if (env) qs.set('environment', env);
  if (alarmName) qs.set('alarmName', alarmName);
  const { res, json } = await api(`/api/admin/alerts?${qs.toString()}`, { method: 'GET', token });
  $('out').textContent = pretty(json);
  if (!res.ok) return setStatus('listStatus', `list failed (${res.status})`, 'bad');
  setStatus('listStatus', `ok (${json.alerts?.length ?? 0} alerts)`, 'good');
}

$('btnSave').addEventListener('click', () => onSave());
$('btnList').addEventListener('click', () => onList().catch((e) => setStatus('listStatus', String(e), 'bad')));

setToken(getToken());

