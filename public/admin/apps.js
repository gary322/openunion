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

  // Registry list for moderation.
  const { res: res2, json: json2 } = await api('/api/admin/apps?page=1&limit=200', { token });
  const appsTbody = $('appsList');
  appsTbody.innerHTML = '';
  if (!res2.ok) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="7">apps list failed (${res2.status})</td>`;
    appsTbody.appendChild(tr);
    return;
  }

  const apps = json2.apps || [];
  for (const a of apps) {
    const tr = document.createElement('tr');
    const dash = a.dashboardUrl ? `<a href="${a.dashboardUrl}">link</a>` : '-';
    const btnLabel = a.status === 'disabled' ? 'Enable' : 'Disable';
    const nextStatus = a.status === 'disabled' ? 'active' : 'disabled';
    tr.innerHTML = `
      <td class="mono">${a.id}</td>
      <td class="mono">${a.slug}</td>
      <td class="mono">${a.taskType}</td>
      <td>${a.status}</td>
      <td>${a.public ? 'yes' : 'no'}</td>
      <td>${dash}</td>
      <td><button data-app-id="${a.id}" data-next="${nextStatus}">${btnLabel}</button></td>
    `;
    appsTbody.appendChild(tr);
  }

  for (const btn of appsTbody.querySelectorAll('button[data-app-id]')) {
    btn.addEventListener('click', async (ev) => {
      const b = ev.currentTarget;
      const appId = b.getAttribute('data-app-id');
      const next = b.getAttribute('data-next');
      if (!appId || !next) return;
      b.disabled = true;
      try {
        const r = await api(`/api/admin/apps/${encodeURIComponent(appId)}/status`, { method: 'POST', token, body: { status: next } });
        if (!r.res.ok) {
          $('status').textContent = `set status failed (${r.res.status})`;
        }
      } finally {
        b.disabled = false;
        refresh().catch(() => {});
      }
    });
  }
}

$('btnSave').addEventListener('click', () => {
  const t = $('adminToken').value.trim();
  if (t) setToken(t);
});
$('btnRefresh').addEventListener('click', () => refresh());

setToken(getToken());
refresh().catch(() => {});
