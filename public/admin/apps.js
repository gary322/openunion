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

function fmtCents(c) {
  const n = Number(c || 0);
  return `$${(n / 100).toFixed(2)}`;
}

async function refresh() {
  $('status').textContent = '';
  const token = $('adminToken').value.trim();
  if (!token) {
    $('status').textContent = 'missing token';
    return;
  }

  const { res, json } = await api('/api/admin/apps/summary', { token });
  if (!res.ok) {
    $('status').textContent = `load failed (${res.status})`;
    return;
  }
  const rows = json.apps || [];
  $('status').textContent = `updated ${json.updatedAt}`;

  const tbody = $('rows');
  tbody.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono">${r.taskType}</td>
      <td>${r.jobsTotal}</td>
      <td>${r.jobsOpen}</td>
      <td>${r.jobsDone}</td>
      <td>${r.pass}</td>
      <td>${r.fail}</td>
      <td>${fmtCents(r.avgPayoutCents)}</td>
      <td>${fmtCents(r.totalPaidCents)}</td>
      <td>${fmtCents(r.avgPaidPerWorkerCents)}</td>
      <td>${r.avgCompletionSec == null ? '-' : Math.round(r.avgCompletionSec)}</td>
    `;
    tbody.appendChild(tr);
  }
}

$('btnSave').addEventListener('click', () => {
  const t = $('adminToken').value.trim();
  if (t) setToken(t);
});
$('btnRefresh').addEventListener('click', () => refresh());

setToken(getToken());
refresh().catch(() => {});
