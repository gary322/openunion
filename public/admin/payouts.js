import { LS, authHeader, copyToClipboard, fetchJson, formatAgo, formatCents, startPolling, storageGet, storageSet, toast } from '/ui/pw.js';

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

function formatIn(tsMs) {
  const ts = Number(tsMs ?? 0);
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const delta = ts - Date.now();
  if (delta <= 0) return 'ready';
  const s = Math.floor(delta / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `in ${h}h`;
  const d = Math.floor(h / 24);
  return `in ${d}d`;
}

function payoutStatusBadge(status, blockedReason) {
  const s = String(status ?? '');
  const span = document.createElement('span');
  let cls = 'pw-chip';
  if (s === 'paid') cls += ' good';
  else if (s === 'failed' || s === 'refunded') cls += ' bad';
  else if (blockedReason) cls += ' faint';
  span.className = cls;
  span.textContent = s || '—';
  return span;
}

function renderPayoutRows(payouts) {
  const tbody = $('payoutRows');
  if (!tbody) return;
  tbody.innerHTML = '';

  const rows = Array.isArray(payouts) ? payouts : [];
  for (const p of rows) {
    const tr = document.createElement('tr');

    const tdStatus = document.createElement('td');
    tdStatus.appendChild(payoutStatusBadge(p?.status, p?.blockedReason));
    if (p?.blockedReason) {
      const br = document.createElement('div');
      br.className = 'pw-muted';
      br.textContent = String(p.blockedReason).slice(0, 80);
      tdStatus.appendChild(br);
    }

    const tdAmt = document.createElement('td');
    tdAmt.textContent = formatCents(p?.amountCents ?? 0);

    const tdNet = document.createElement('td');
    tdNet.textContent = p?.netAmountCents === null || p?.netAmountCents === undefined ? '—' : formatCents(p.netAmountCents);

    const tdFees = document.createElement('td');
    const pf = p?.platformFeeCents === null || p?.platformFeeCents === undefined ? null : formatCents(p.platformFeeCents);
    const pw = p?.proofworkFeeCents === null || p?.proofworkFeeCents === undefined ? null : formatCents(p.proofworkFeeCents);
    tdFees.textContent = pf || pw ? `platform ${pf || '—'} / pw ${pw || '—'}` : '—';

    const tdHold = document.createElement('td');
    const holdUntil = Number(p?.holdUntil ?? 0);
    if (holdUntil && (p?.status === 'pending' || p?.status === 'failed')) {
      tdHold.textContent = formatIn(holdUntil);
    } else {
      tdHold.textContent = '—';
    }

    const tdTask = document.createElement('td');
    tdTask.className = 'pw-mono';
    tdTask.textContent = String(p?.taskType ?? '—');

    const tdOrg = document.createElement('td');
    tdOrg.className = 'pw-mono';
    tdOrg.textContent = String(p?.orgId ?? '—');

    const tdWorker = document.createElement('td');
    tdWorker.textContent = p?.workerDisplayName ? String(p.workerDisplayName) : String(p?.workerId ?? '—');
    if (p?.workerId) {
      const sub = document.createElement('div');
      sub.className = 'pw-muted pw-mono';
      sub.textContent = String(p.workerId);
      tdWorker.appendChild(sub);
    }

    const tdCreated = document.createElement('td');
    tdCreated.textContent = p?.createdAt ? formatAgo(p.createdAt) : '—';

    const tdActions = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'pw-actions';

    const id = String(p?.id ?? '');
    const btnCopy = document.createElement('button');
    btnCopy.type = 'button';
    btnCopy.className = 'pw-btn';
    btnCopy.textContent = 'Copy id';
    btnCopy.addEventListener('click', () => copyToClipboard(id));
    actions.appendChild(btnCopy);

    const btnRetry = document.createElement('button');
    btnRetry.type = 'button';
    btnRetry.className = 'pw-btn';
    btnRetry.textContent = 'Retry';
    btnRetry.disabled = !id;
    btnRetry.addEventListener('click', () => {
      $('payoutId').value = id;
      onRetry().catch((e) => setStatus('retryStatus', String(e), 'bad'));
    });
    actions.appendChild(btnRetry);

    const btnMark = document.createElement('button');
    btnMark.type = 'button';
    btnMark.className = 'pw-btn';
    btnMark.textContent = 'Mark…';
    btnMark.disabled = !id;
    btnMark.addEventListener('click', () => {
      $('markPayoutId').value = id;
      $('markReason').focus();
      toast('Fill reason then Mark', '');
    });
    actions.appendChild(btnMark);

    tdActions.appendChild(actions);

    tr.appendChild(tdStatus);
    tr.appendChild(tdAmt);
    tr.appendChild(tdNet);
    tr.appendChild(tdFees);
    tr.appendChild(tdHold);
    tr.appendChild(tdTask);
    tr.appendChild(tdOrg);
    tr.appendChild(tdWorker);
    tr.appendChild(tdCreated);
    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  }

  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 10;
    td.className = 'pw-muted';
    td.textContent = 'No payouts match your filters.';
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

let lastListPayload = null;
async function onList({ silent = false } = {}) {
  if (!silent) setStatus('listStatus', '', null);
  const token = requireToken();
  const status = String($('statusFilter')?.value ?? '').trim();
  const orgId = String($('orgIdFilter')?.value ?? '').trim();
  const page = Math.max(1, Number(String($('page')?.value ?? '1')));
  const limit = Math.max(1, Math.min(200, Number(String($('limit')?.value ?? '50'))));

  const qs = new URLSearchParams();
  qs.set('page', String(page));
  qs.set('limit', String(limit));
  if (status) qs.set('status', status);
  if (orgId) qs.set('orgId', orgId);

  const { ok, status: st, json } = await api(`/api/admin/payouts?${qs.toString()}`, { method: 'GET', token });
  lastListPayload = json;
  const out = $('out');
  if (out) out.textContent = pretty(json);

  if (!ok) {
    if (!silent) setStatus('listStatus', `list failed (${st})`, 'bad');
    return;
  }

  renderPayoutRows(json?.payouts);
  setText('lastUpdated', new Date().toLocaleTimeString());
  if (!silent) setStatus('listStatus', `ok (${json?.payouts?.length ?? 0} payouts)`, 'good');
}

async function onRetry() {
  setStatus('retryStatus', '', null);
  const token = requireToken();
  const payoutId = String($('payoutId')?.value ?? '').trim();
  if (!payoutId) return setStatus('retryStatus', 'missing payoutId', 'bad');

  const { ok, status, json } = await api(`/api/admin/payouts/${encodeURIComponent(payoutId)}/retry`, { method: 'POST', token });
  const out = $('out');
  if (out) out.textContent = pretty(json ?? lastListPayload ?? {});
  if (!ok) return setStatus('retryStatus', `retry failed (${status})`, 'bad');
  setStatus('retryStatus', 'ok', 'good');
  toast('Retry queued', 'good');
  onList({ silent: true }).catch(() => {});
}

async function onMark() {
  setStatus('markStatusMsg', '', null);
  const token = requireToken();
  const payoutId = String($('markPayoutId')?.value ?? '').trim();
  if (!payoutId) return setStatus('markStatusMsg', 'missing payoutId', 'bad');

  const statusVal = String($('markStatus')?.value ?? '').trim();
  const provider = String($('markProvider')?.value ?? '').trim() || null;
  const providerRef = String($('markProviderRef')?.value ?? '').trim() || null;
  const reason = String($('markReason')?.value ?? '').trim();
  if (!reason) return setStatus('markStatusMsg', 'missing reason', 'bad');

  const { ok, status, json } = await api(`/api/admin/payouts/${encodeURIComponent(payoutId)}/mark`, {
    method: 'POST',
    token,
    body: { status: statusVal, provider, providerRef, reason },
  });
  const out = $('out');
  if (out) out.textContent = pretty(json ?? {});
  if (!ok) return setStatus('markStatusMsg', `mark failed (${status})`, 'bad');
  setStatus('markStatusMsg', 'ok', 'good');
  toast('Marked payout', 'good');
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
$('btnRetry')?.addEventListener('click', () => onRetry().catch((e) => setStatus('retryStatus', String(e), 'bad')));
$('btnMark')?.addEventListener('click', () => onMark().catch((e) => setStatus('markStatusMsg', String(e), 'bad')));

$('btnAutoRefresh')?.addEventListener('click', () => {
  const btn = $('btnAutoRefresh');
  const next = String(btn?.getAttribute('aria-pressed') ?? 'false') !== 'true';
  setAuto(next);
  toast(next ? 'Auto refresh on' : 'Auto refresh off', next ? 'good' : '');
});

setToken(getToken());
