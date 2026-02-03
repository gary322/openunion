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
  const orgId = $('orgIdFilter').value.trim();
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (orgId) qs.set('orgId', orgId);
  const { res, json } = await api(`/api/admin/payouts?${qs.toString()}`, { method: 'GET', token });
  $('out').textContent = pretty(json);
  if (!res.ok) return setStatus('listStatus', `list failed (${res.status})`, 'bad');
  setStatus('listStatus', `ok (${json.payouts?.length ?? 0} payouts)`, 'good');
}

async function onRetry() {
  setStatus('retryStatus', '', null);
  const token = requireToken();
  const payoutId = $('payoutId').value.trim();
  if (!payoutId) return setStatus('retryStatus', 'missing payoutId', 'bad');
  const { res, json } = await api(`/api/admin/payouts/${encodeURIComponent(payoutId)}/retry`, { method: 'POST', token });
  $('out').textContent = pretty(json);
  if (!res.ok) return setStatus('retryStatus', `retry failed (${res.status})`, 'bad');
  setStatus('retryStatus', 'ok', 'good');
}

async function onMark() {
  setStatus('markStatusMsg', '', null);
  const token = requireToken();
  const payoutId = $('markPayoutId').value.trim();
  if (!payoutId) return setStatus('markStatusMsg', 'missing payoutId', 'bad');

  const status = $('markStatus').value;
  const provider = $('markProvider').value.trim() || null;
  const providerRef = $('markProviderRef').value.trim() || null;
  const reason = $('markReason').value.trim();
  if (!reason) return setStatus('markStatusMsg', 'missing reason', 'bad');

  const { res, json } = await api(`/api/admin/payouts/${encodeURIComponent(payoutId)}/mark`, {
    method: 'POST',
    token,
    body: { status, provider, providerRef, reason },
  });
  $('out').textContent = pretty(json);
  if (!res.ok) return setStatus('markStatusMsg', `mark failed (${res.status})`, 'bad');
  setStatus('markStatusMsg', 'ok', 'good');
}

$('btnSave').addEventListener('click', () => onSave());
$('btnList').addEventListener('click', () => onList().catch((e) => setStatus('listStatus', String(e), 'bad')));
$('btnRetry').addEventListener('click', () => onRetry().catch((e) => setStatus('retryStatus', String(e), 'bad')));
$('btnMark').addEventListener('click', () => onMark().catch((e) => setStatus('markStatusMsg', String(e), 'bad')));

setToken(getToken());
