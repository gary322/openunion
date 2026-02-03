const apiBase = window.location.origin;

function $(id) {
  return document.getElementById(id);
}

function getToken() {
  return localStorage.getItem('pw_admin_token') || '';
}

function setToken(token) {
  localStorage.setItem('pw_admin_token', token);
  $('adminToken').value = token;
}

function setStatus(id, msg, kind) {
  const el = $(id);
  el.textContent = msg || '';
  el.classList.remove('good', 'bad');
  if (kind) el.classList.add(kind);
}

function pretty(obj) {
  return JSON.stringify(obj, null, 2);
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

async function getArtifact() {
  setStatus('getStatus', '', null);
  const token = $('adminToken').value.trim();
  const id = $('artifactId').value.trim();
  if (!token) return setStatus('getStatus', 'missing token', 'bad');
  if (!id) return setStatus('getStatus', 'missing artifactId', 'bad');
  const { res, json } = await api(`/api/artifacts/${encodeURIComponent(id)}`, { method: 'GET', token });
  $('out').textContent = pretty(json);
  if (!res.ok) return setStatus('getStatus', `get failed (${res.status})`, 'bad');
  setStatus('getStatus', 'ok', 'good');
}

async function quarantine() {
  setStatus('qStatus', '', null);
  const token = $('adminToken').value.trim();
  const id = $('artifactId').value.trim();
  const reason = $('reason').value.trim();
  if (!token) return setStatus('qStatus', 'missing token', 'bad');
  if (!id) return setStatus('qStatus', 'missing artifactId', 'bad');
  if (!reason) return setStatus('qStatus', 'missing reason', 'bad');
  const { res, json } = await api(`/api/admin/artifacts/${encodeURIComponent(id)}/quarantine`, { method: 'POST', token, body: { reason } });
  $('out').textContent = pretty(json);
  if (!res.ok) return setStatus('qStatus', `quarantine failed (${res.status})`, 'bad');
  setStatus('qStatus', 'quarantined', 'good');
}

async function del() {
  setStatus('delStatus', '', null);
  const token = $('adminToken').value.trim();
  const id = $('artifactId').value.trim();
  if (!token) return setStatus('delStatus', 'missing token', 'bad');
  if (!id) return setStatus('delStatus', 'missing artifactId', 'bad');
  const { res, json } = await api(`/api/admin/artifacts/${encodeURIComponent(id)}/delete`, { method: 'POST', token });
  $('out').textContent = pretty(json);
  if (!res.ok) return setStatus('delStatus', `delete failed (${res.status})`, 'bad');
  setStatus('delStatus', 'deleted', 'good');
}

$('btnSave').addEventListener('click', () => {
  const t = $('adminToken').value.trim();
  if (t) setToken(t);
  setStatus('authStatus', t ? 'saved' : 'missing token', t ? 'good' : 'bad');
});

$('btnGet').addEventListener('click', () => getArtifact().catch((e) => setStatus('getStatus', String(e), 'bad')));
$('btnQuarantine').addEventListener('click', () => quarantine().catch((e) => setStatus('qStatus', String(e), 'bad')));
$('btnDelete').addEventListener('click', () => del().catch((e) => setStatus('delStatus', String(e), 'bad')));

setToken(getToken());

