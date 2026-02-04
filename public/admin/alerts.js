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

function stateBadge(newStateValue) {
  const s = String(newStateValue ?? '');
  const span = document.createElement('span');
  let cls = 'pw-chip';
  if (s === 'OK') cls += ' good';
  else if (s === 'ALARM') cls += ' bad';
  else cls += ' faint';
  span.className = cls;
  span.textContent = s || '—';
  return span;
}

function renderAlertRows(alerts) {
  const tbody = $('alertRows');
  if (!tbody) return;
  tbody.innerHTML = '';

  const rows = Array.isArray(alerts) ? alerts : [];
  for (const a of rows) {
    const tr = document.createElement('tr');

    const tdEnv = document.createElement('td');
    tdEnv.className = 'pw-mono';
    tdEnv.textContent = String(a?.environment ?? '—');

    const tdAlarm = document.createElement('td');
    tdAlarm.textContent = String(a?.alarmName ?? '—');
    const idLine = document.createElement('div');
    idLine.className = 'pw-muted pw-mono';
    idLine.textContent = String(a?.id ?? '');
    tdAlarm.appendChild(idLine);

    const tdState = document.createElement('td');
    tdState.appendChild(stateBadge(a?.newStateValue));

    const tdChange = document.createElement('td');
    tdChange.textContent = a?.stateChangeTime ? formatAgo(Date.parse(String(a.stateChangeTime))) : '—';

    const tdRecv = document.createElement('td');
    tdRecv.textContent = a?.receivedAt ? formatAgo(Date.parse(String(a.receivedAt))) : '—';

    const tdReason = document.createElement('td');
    tdReason.textContent = String(a?.stateReason ?? '').slice(0, 120) || '—';

    const tdActions = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'pw-actions';
    const btnCopy = document.createElement('button');
    btnCopy.type = 'button';
    btnCopy.className = 'pw-btn';
    btnCopy.textContent = 'Copy id';
    btnCopy.addEventListener('click', () => copyToClipboard(String(a?.id ?? '')));
    actions.appendChild(btnCopy);
    tdActions.appendChild(actions);

    tr.appendChild(tdEnv);
    tr.appendChild(tdAlarm);
    tr.appendChild(tdState);
    tr.appendChild(tdChange);
    tr.appendChild(tdRecv);
    tr.appendChild(tdReason);
    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  }

  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'pw-muted';
    td.textContent = 'No alerts match your filters.';
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
  const env = String($('envFilter')?.value ?? '').trim();
  const alarmName = String($('alarmFilter')?.value ?? '').trim();
  const page = Math.max(1, Number(String($('page')?.value ?? '1')));
  const limit = Math.max(1, Math.min(200, Number(String($('limit')?.value ?? '50'))));

  const qs = new URLSearchParams();
  qs.set('page', String(page));
  qs.set('limit', String(limit));
  if (env) qs.set('environment', env);
  if (alarmName) qs.set('alarmName', alarmName);

  const { ok, status, json } = await api(`/api/admin/alerts?${qs.toString()}`, { method: 'GET', token });
  const out = $('out');
  if (out) out.textContent = pretty(json);
  if (!ok) {
    if (!silent) setStatus('listStatus', `list failed (${status})`, 'bad');
    return;
  }

  renderAlertRows(json?.alerts);
  setText('lastUpdated', new Date().toLocaleTimeString());
  if (!silent) setStatus('listStatus', `ok (${json?.alerts?.length ?? 0} alerts)`, 'good');
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
$('btnAutoRefresh')?.addEventListener('click', () => {
  const btn = $('btnAutoRefresh');
  const next = String(btn?.getAttribute('aria-pressed') ?? 'false') !== 'true';
  setAuto(next);
  toast(next ? 'Auto refresh on' : 'Auto refresh off', next ? 'good' : '');
});

setToken(getToken());

