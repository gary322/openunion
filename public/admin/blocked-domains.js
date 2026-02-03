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

async function list() {
  setStatus('listStatus', '', null);
  const token = $('adminToken').value.trim();
  if (!token) return setStatus('listStatus', 'missing token', 'bad');

  const { res, json } = await api('/api/admin/blocked-domains?page=1&limit=200', { token });
  $('out').textContent = pretty(json);
  if (!res.ok) return setStatus('listStatus', `list failed (${res.status})`, 'bad');

  const rows = Array.isArray(json?.blockedDomains) ? json.blockedDomains : [];
  const tbody = $('rows');
  tbody.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono">${r.id}</td>
      <td class="mono">${r.domain}</td>
      <td>${r.reason || ''}</td>
      <td class="mono">${r.createdAt || ''}</td>
      <td><button class="danger" data-del="${r.id}">Delete</button></td>
    `;
    tbody.appendChild(tr);
  }

  for (const btn of tbody.querySelectorAll('button[data-del]')) {
    btn.addEventListener('click', async (ev) => {
      const b = ev.currentTarget;
      const id = b.getAttribute('data-del');
      if (!id) return;
      b.disabled = true;
      try {
        const r = await api(`/api/admin/blocked-domains/${encodeURIComponent(id)}`, { method: 'DELETE', token });
        if (!r.res.ok) setStatus('listStatus', `delete failed (${r.res.status})`, 'bad');
      } finally {
        b.disabled = false;
        list().catch(() => {});
      }
    });
  }

  setStatus('listStatus', `ok (${rows.length})`, 'good');
}

async function upsert() {
  setStatus('upsertStatus', '', null);
  const token = $('adminToken').value.trim();
  if (!token) return setStatus('upsertStatus', 'missing token', 'bad');

  const domain = $('domain').value.trim();
  const reason = $('reason').value.trim() || null;
  if (!domain) return setStatus('upsertStatus', 'missing domain', 'bad');

  const { res, json } = await api('/api/admin/blocked-domains', { method: 'POST', token, body: { domain, reason } });
  if (!res.ok) {
    setStatus('upsertStatus', `upsert failed (${res.status})`, 'bad');
    $('out').textContent = pretty(json);
    return;
  }
  setStatus('upsertStatus', `saved ${json?.blockedDomain?.domain || ''}`, 'good');
  list().catch(() => {});
}

$('btnSave').addEventListener('click', () => {
  const t = $('adminToken').value.trim();
  if (t) setToken(t);
  setStatus('authStatus', t ? 'saved' : 'missing token', t ? 'good' : 'bad');
});

$('btnList').addEventListener('click', () => list().catch((e) => setStatus('listStatus', String(e), 'bad')));
$('btnUpsert').addEventListener('click', () => upsert().catch((e) => setStatus('upsertStatus', String(e), 'bad')));

setToken(getToken());

