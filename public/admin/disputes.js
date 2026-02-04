import { LS, authHeader, copyToClipboard, fetchJson, formatAgo, startPolling, storageGet, storageSet, toast } from '/ui/pw.js';

const apiBase = window.location.origin;

function $(id) {
  return document.getElementById(id);
}

function setStatus(id, text, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || '';
  el.classList.remove('good', 'bad');
  if (kind) el.classList.add(kind);
}

function setText(id, text) {
  const el = $(id);
  if (!el) return;
  el.textContent = String(text ?? '');
}

function pretty(obj) {
  return JSON.stringify(obj, null, 2);
}

function getToken() {
  return storageGet(LS.adminToken, '');
}

function setToken(token) {
  storageSet(LS.adminToken, token);
  const input = $('adminToken');
  if (input) input.value = token;
}

function requireToken() {
  const t = String($('adminToken')?.value ?? '').trim();
  if (!t) throw new Error('missing admin token');
  return t;
}

function disputeStatusBadge(status) {
  const s = String(status ?? '');
  const span = document.createElement('span');
  let cls = 'pw-chip';
  if (s === 'resolved') cls += ' good';
  else if (s === 'cancelled') cls += ' faint';
  else cls += ' bad'; // open
  span.className = cls;
  span.textContent = s || '—';
  return span;
}

function renderDisputeRows(disputes) {
  const tbody = $('disputeRows');
  if (!tbody) return;
  tbody.innerHTML = '';

  const rows = Array.isArray(disputes) ? disputes : [];
  for (const d of rows) {
    const tr = document.createElement('tr');

    const tdStatus = document.createElement('td');
    tdStatus.appendChild(disputeStatusBadge(d?.status));

    const tdId = document.createElement('td');
    tdId.className = 'pw-mono';
    tdId.textContent = String(d?.id ?? '');

    const tdPayout = document.createElement('td');
    tdPayout.className = 'pw-mono';
    tdPayout.textContent = String(d?.payoutId ?? '—');

    const tdOrg = document.createElement('td');
    tdOrg.className = 'pw-mono';
    tdOrg.textContent = String(d?.orgId ?? '—');

    const tdReason = document.createElement('td');
    tdReason.textContent = String(d?.reason ?? '—').slice(0, 120);

    const tdCreated = document.createElement('td');
    tdCreated.textContent = d?.createdAt ? formatAgo(d.createdAt) : '—';

    const tdResolved = document.createElement('td');
    tdResolved.textContent = d?.resolvedAt ? formatAgo(d.resolvedAt) : '—';

    const tdActions = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'pw-actions';

    const btnCopy = document.createElement('button');
    btnCopy.type = 'button';
    btnCopy.className = 'pw-btn';
    btnCopy.textContent = 'Copy id';
    btnCopy.addEventListener('click', () => copyToClipboard(String(d?.id ?? '')));
    actions.appendChild(btnCopy);

    const btnResolve = document.createElement('button');
    btnResolve.type = 'button';
    btnResolve.className = 'pw-btn primary';
    btnResolve.textContent = 'Resolve…';
    btnResolve.disabled = String(d?.status ?? '') !== 'open';
    btnResolve.addEventListener('click', () => {
      $('disputeId').value = String(d?.id ?? '');
      $('notes').focus();
      toast('Pick resolution then Resolve', '');
    });
    actions.appendChild(btnResolve);

    tdActions.appendChild(actions);

    tr.appendChild(tdStatus);
    tr.appendChild(tdId);
    tr.appendChild(tdPayout);
    tr.appendChild(tdOrg);
    tr.appendChild(tdReason);
    tr.appendChild(tdCreated);
    tr.appendChild(tdResolved);
    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  }

  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.className = 'pw-muted';
    td.textContent = 'No disputes match your filters.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetchJson(`${apiBase}${path}`, {
    method,
    headers: { ...authHeader(token) },
    body,
    credentials: 'include',
  });
  return { ok: res.ok, status: res.status, json: res.json };
}

function onSave() {
  const t = String($('adminToken')?.value ?? '').trim();
  if (!t) return setStatus('authStatus', 'missing token', 'bad');
  setToken(t);
  setStatus('authStatus', 'token saved', 'good');
  toast('Saved admin token', 'good');
}

async function onList({ silent = false } = {}) {
  if (!silent) setStatus('listStatus', '', null);
  const token = requireToken();
  const statusFilter = String($('statusFilter')?.value ?? '').trim();
  const page = Math.max(1, Number(String($('page')?.value ?? '1')));
  const limit = Math.max(1, Math.min(200, Number(String($('limit')?.value ?? '50'))));

  const qs = new URLSearchParams();
  qs.set('page', String(page));
  qs.set('limit', String(limit));
  if (statusFilter) qs.set('status', statusFilter);

  const { ok, status, json } = await api(`/api/admin/disputes?${qs.toString()}`, { method: 'GET', token });
  const out = $('out');
  if (out) out.textContent = pretty(json);
  if (!ok) {
    if (!silent) setStatus('listStatus', `list failed (${status})`, 'bad');
    return;
  }

  renderDisputeRows(json?.disputes);
  setText('lastUpdated', new Date().toLocaleTimeString());
  if (!silent) setStatus('listStatus', `ok (${json?.disputes?.length ?? 0} disputes)`, 'good');
}

async function onResolve() {
  setStatus('resolveStatus', '', null);
  const token = requireToken();
  const disputeId = String($('disputeId')?.value ?? '').trim();
  if (!disputeId) return setStatus('resolveStatus', 'missing disputeId', 'bad');
  const resolution = String($('resolution')?.value ?? 'refund');
  const notes = String($('notes')?.value ?? '').trim() || null;

  const { ok, status, json } = await api(`/api/admin/disputes/${encodeURIComponent(disputeId)}/resolve`, {
    method: 'POST',
    token,
    body: { resolution, notes },
  });
  const out = $('out');
  if (out) out.textContent = pretty(json ?? {});
  if (!ok) return setStatus('resolveStatus', `resolve failed (${status})`, 'bad');
  setStatus('resolveStatus', 'ok', 'good');
  toast('Resolved dispute', 'good');
  onList({ silent: true }).catch(() => {});
}

let stopAuto = null;
function setAuto(on) {
  const btn = $('btnAutoRefresh');
  if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  if (stopAuto) stopAuto();
  stopAuto = null;
  if (on) {
    stopAuto = startPolling(() => onList({ silent: true }), { intervalMs: 3500, immediate: true });
  }
}

$('btnSave')?.addEventListener('click', () => onSave());
$('btnList')?.addEventListener('click', () => onList().catch((e) => setStatus('listStatus', String(e), 'bad')));
$('btnResolve')?.addEventListener('click', () => onResolve().catch((e) => setStatus('resolveStatus', String(e), 'bad')));
$('btnAutoRefresh')?.addEventListener('click', () => {
  const btn = $('btnAutoRefresh');
  const next = String(btn?.getAttribute('aria-pressed') ?? 'false') !== 'true';
  setAuto(next);
  toast(next ? 'Auto refresh on' : 'Auto refresh off', next ? 'good' : '');
});

setToken(getToken());
