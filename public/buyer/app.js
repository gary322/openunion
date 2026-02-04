import { copyToClipboard, formatAgo, toast } from '/ui/pw.js';

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

function toMs(ts) {
  if (ts === null || ts === undefined) return 0;
  if (typeof ts === 'number') return ts;
  const s = String(ts).trim();
  if (!s) return 0;
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return n;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : 0;
}

function getBuyerToken() {
  return localStorage.getItem('pw_buyer_token') || '';
}

function setBuyerToken(token) {
  localStorage.setItem('pw_buyer_token', token);
  $('buyerToken').value = token;
}

function getCsrfToken() {
  return localStorage.getItem('pw_csrf_token') || '';
}

function setCsrfToken(token) {
  localStorage.setItem('pw_csrf_token', token);
}

function setBadge(id, text) {
  const el = $(id);
  if (!el) return;
  el.textContent = String(text ?? '');
}

function setStepDone(id, done) {
  const el = $(id);
  if (!el) return;
  el.classList.toggle('done', Boolean(done));
}

function setText(id, text) {
  const el = $(id);
  if (!el) return;
  el.textContent = String(text ?? '');
}

let onboardingReqNo = 0;
async function refreshOnboardingStatus() {
  const reqNo = ++onboardingReqNo;

  const token = $('buyerToken')?.value?.trim?.() || getBuyerToken();
  const hasToken = Boolean(token);

  setStepDone('stepToken', hasToken);
  if (!hasToken) {
    setStepDone('stepOrigin', false);
    setStepDone('stepFees', false);
    setStepDone('stepApp', false);
    setStepDone('stepPublish', false);
    setStepDone('stepPaid', false);
    setBadge('navBadgeOnboarding', '6');
    setBadge('navBadgeIntegrations', '-');
    setBadge('navBadgeApps', '-');
    setBadge('navBadgeWork', '-');
    setBadge('navBadgeMoney', '-');
    setBadge('navBadgeDisputes', '-');
    return;
  }

  let verifiedOrigins = 0;
  try {
    const { res, json } = await api('/api/origins', { method: 'GET', token });
    if (res.ok) {
      const origins = Array.isArray(json?.origins) ? json.origins : [];
      verifiedOrigins = origins.filter((o) => String(o?.status ?? '') === 'verified').length;
    }
  } catch {
    // ignore
  }

  let feeOk = false;
  try {
    const { res, json } = await api('/api/org/platform-fee', { method: 'GET', token });
    if (res.ok) {
      const bps = Number(json?.platformFeeBps ?? 0);
      const wallet = String(json?.platformFeeWalletAddress ?? '').trim();
      feeOk = Number.isFinite(bps) && (bps <= 0 || wallet.length > 0);
    }
  } catch {
    // ignore
  }

  let appsCount = 0;
  try {
    const { res, json } = await api('/api/org/apps?page=1&limit=1', { method: 'GET', token });
    if (res.ok) {
      const apps = Array.isArray(json?.apps) ? json.apps : [];
      appsCount = typeof json?.total === 'number' ? Number(json.total) : apps.length;
    }
  } catch {
    // ignore
  }

  let publishedBounties = 0;
  try {
    const { res, json } = await api('/api/bounties?page=1&limit=1&status=published', { method: 'GET', token });
    if (res.ok) {
      publishedBounties = typeof json?.total === 'number' ? Number(json.total) : 0;
    }
  } catch {
    // ignore
  }

  let paidCount = 0;
  try {
    const { res, json } = await api('/api/org/earnings', { method: 'GET', token });
    if (res.ok) {
      paidCount = Number(json?.totals?.paidCount ?? 0);
    }
  } catch {
    // ignore
  }

  let openDisputes = 0;
  try {
    const { res, json } = await api('/api/org/disputes?page=1&limit=1&status=open', { method: 'GET', token });
    if (res.ok) {
      openDisputes = typeof json?.total === 'number' ? Number(json.total) : 0;
    }
  } catch {
    // ignore
  }

  if (reqNo !== onboardingReqNo) return;

  setStepDone('stepOrigin', verifiedOrigins > 0);
  setStepDone('stepFees', feeOk);
  setStepDone('stepApp', appsCount > 0);
  setStepDone('stepPublish', publishedBounties > 0);
  setStepDone('stepPaid', paidCount > 0);

  const remaining =
    (hasToken ? 0 : 1) +
    (verifiedOrigins > 0 ? 0 : 1) +
    (feeOk ? 0 : 1) +
    (appsCount > 0 ? 0 : 1) +
    (publishedBounties > 0 ? 0 : 1) +
    (paidCount > 0 ? 0 : 1);

  setBadge('navBadgeOnboarding', String(remaining));
  setBadge('navBadgeIntegrations', verifiedOrigins > 0 ? String(verifiedOrigins) : '!');
  setBadge('navBadgeApps', String(appsCount));
  setBadge('navBadgeWork', String(publishedBounties));
  setBadge('navBadgeMoney', String(paidCount));
  setBadge('navBadgeDisputes', openDisputes > 0 ? String(openDisputes) : '0');
}

function originRecordName(originUrl) {
  try {
    const u = new URL(String(originUrl || '').trim());
    if (!u.hostname) return '';
    return `_proofwork.${u.hostname}`;
  } catch {
    return '';
  }
}

function originHttpFileUrl(originUrl) {
  try {
    return new URL('/.well-known/proofwork-verify.txt', String(originUrl || '').trim()).toString();
  } catch {
    return '';
  }
}

function clearNode(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

function renderOriginGuide(origin) {
  const kicker = $('originGuideKicker');
  const body = $('originGuideBody');
  if (!kicker || !body) return;

  if (!origin) {
    kicker.textContent = 'Add an origin to see the exact steps';
    clearNode(body);
    body.appendChild(document.createElement('div')).className = 'pw-muted';
    body.lastChild.textContent = 'Tip: use https origins in production. Verification runs from Proofwork servers (no private networks).';
    return;
  }

  const status = String(origin?.status ?? 'pending');
  const method = String(origin?.method ?? '');
  const originUrl = String(origin?.origin ?? '');
  const token = String(origin?.token ?? '');
  const verifiedAt = toMs(origin?.verifiedAt);
  const failure = String(origin?.failureReason ?? '').trim();

  kicker.textContent = `${status}${method ? ` • ${method}` : ''}`;
  clearNode(body);

  const top = document.createElement('div');
  top.className = 'pw-row';

  const left = document.createElement('div');
  left.className = 'pw-field';
  const leftLab = document.createElement('div');
  leftLab.className = 'pw-kicker';
  leftLab.textContent = 'Origin';
  const leftVal = document.createElement('div');
  leftVal.className = 'pw-mono';
  leftVal.textContent = originUrl;
  left.appendChild(leftLab);
  left.appendChild(leftVal);

  const right = document.createElement('div');
  right.className = 'pw-field';
  const rightLab = document.createElement('div');
  rightLab.className = 'pw-kicker';
  rightLab.textContent = 'Token';
  const rightVal = document.createElement('div');
  rightVal.className = 'pw-mono';
  rightVal.textContent = token || '—';
  const rightActions = document.createElement('div');
  rightActions.className = 'pw-actions';
  const btnCopy = document.createElement('button');
  btnCopy.type = 'button';
  btnCopy.className = 'pw-btn';
  btnCopy.textContent = 'Copy token';
  btnCopy.addEventListener('click', () => copyToClipboard(token));
  rightActions.appendChild(btnCopy);
  right.appendChild(rightLab);
  right.appendChild(rightVal);
  right.appendChild(rightActions);

  top.appendChild(left);
  top.appendChild(right);
  body.appendChild(top);

  if (verifiedAt) {
    const v = document.createElement('div');
    v.className = 'pw-badge';
    v.textContent = `Verified ${formatAgo(verifiedAt)}`;
    body.appendChild(v);
  }

  if (failure) {
    const warn = document.createElement('div');
    warn.className = 'pw-status bad';
    warn.textContent = `Last check: ${failure}`;
    body.appendChild(warn);
  }

  const guide = document.createElement('div');
  guide.className = 'pw-card soft';

  const gTitle = document.createElement('div');
  gTitle.className = 'pw-kicker';
  gTitle.textContent = 'Do this once';
  guide.appendChild(gTitle);

  const steps = document.createElement('div');
  steps.className = 'pw-stack';

  if (method === 'dns_txt') {
    const name = originRecordName(originUrl);
    const row = document.createElement('div');
    row.className = 'pw-row';

    const f1 = document.createElement('div');
    f1.className = 'pw-field';
    const l1 = document.createElement('label');
    l1.textContent = 'TXT record name';
    const v1 = document.createElement('input');
    v1.className = 'pw-input pw-mono';
    v1.value = name;
    v1.readOnly = true;
    const a1 = document.createElement('div');
    a1.className = 'pw-actions';
    const c1 = document.createElement('button');
    c1.type = 'button';
    c1.className = 'pw-btn';
    c1.textContent = 'Copy';
    c1.addEventListener('click', () => copyToClipboard(name));
    a1.appendChild(c1);
    f1.appendChild(l1);
    f1.appendChild(v1);
    f1.appendChild(a1);

    const f2 = document.createElement('div');
    f2.className = 'pw-field';
    const l2 = document.createElement('label');
    l2.textContent = 'TXT record value';
    const v2 = document.createElement('input');
    v2.className = 'pw-input pw-mono';
    v2.value = token;
    v2.readOnly = true;
    const a2 = document.createElement('div');
    a2.className = 'pw-actions';
    const c2 = document.createElement('button');
    c2.type = 'button';
    c2.className = 'pw-btn';
    c2.textContent = 'Copy';
    c2.addEventListener('click', () => copyToClipboard(token));
    a2.appendChild(c2);
    f2.appendChild(l2);
    f2.appendChild(v2);
    f2.appendChild(a2);

    row.appendChild(f1);
    row.appendChild(f2);
    steps.appendChild(row);

    const hint = document.createElement('div');
    hint.className = 'pw-muted';
    hint.textContent = 'Then wait for DNS to propagate and click “Check verification”.';
    steps.appendChild(hint);
  } else if (method === 'http_file') {
    const url = originHttpFileUrl(originUrl);
    const row = document.createElement('div');
    row.className = 'pw-row';

    const f1 = document.createElement('div');
    f1.className = 'pw-field';
    const l1 = document.createElement('label');
    l1.textContent = 'URL to serve';
    const v1 = document.createElement('input');
    v1.className = 'pw-input pw-mono';
    v1.value = url;
    v1.readOnly = true;
    const a1 = document.createElement('div');
    a1.className = 'pw-actions';
    const c1 = document.createElement('button');
    c1.type = 'button';
    c1.className = 'pw-btn';
    c1.textContent = 'Copy';
    c1.addEventListener('click', () => copyToClipboard(url));
    a1.appendChild(c1);
    f1.appendChild(l1);
    f1.appendChild(v1);
    f1.appendChild(a1);

    const f2 = document.createElement('div');
    f2.className = 'pw-field';
    const l2 = document.createElement('label');
    l2.textContent = 'File body must include';
    const v2 = document.createElement('input');
    v2.className = 'pw-input pw-mono';
    v2.value = token;
    v2.readOnly = true;
    const a2 = document.createElement('div');
    a2.className = 'pw-actions';
    const c2 = document.createElement('button');
    c2.type = 'button';
    c2.className = 'pw-btn';
    c2.textContent = 'Copy';
    c2.addEventListener('click', () => copyToClipboard(token));
    a2.appendChild(c2);
    f2.appendChild(l2);
    f2.appendChild(v2);
    f2.appendChild(a2);

    row.appendChild(f1);
    row.appendChild(f2);
    steps.appendChild(row);

    const hint = document.createElement('div');
    hint.className = 'pw-muted';
    hint.textContent = 'Make sure the URL returns 200 OK (no redirects) and includes the token.';
    steps.appendChild(hint);
  } else if (method === 'header') {
    const headerName = 'X-Proofwork-Verify';
    const row = document.createElement('div');
    row.className = 'pw-row';

    const f1 = document.createElement('div');
    f1.className = 'pw-field';
    const l1 = document.createElement('label');
    l1.textContent = 'Header name';
    const v1 = document.createElement('input');
    v1.className = 'pw-input pw-mono';
    v1.value = headerName;
    v1.readOnly = true;
    const a1 = document.createElement('div');
    a1.className = 'pw-actions';
    const c1 = document.createElement('button');
    c1.type = 'button';
    c1.className = 'pw-btn';
    c1.textContent = 'Copy';
    c1.addEventListener('click', () => copyToClipboard(headerName));
    a1.appendChild(c1);
    f1.appendChild(l1);
    f1.appendChild(v1);
    f1.appendChild(a1);

    const f2 = document.createElement('div');
    f2.className = 'pw-field';
    const l2 = document.createElement('label');
    l2.textContent = 'Header value must include';
    const v2 = document.createElement('input');
    v2.className = 'pw-input pw-mono';
    v2.value = token;
    v2.readOnly = true;
    const a2 = document.createElement('div');
    a2.className = 'pw-actions';
    const c2 = document.createElement('button');
    c2.type = 'button';
    c2.className = 'pw-btn';
    c2.textContent = 'Copy';
    c2.addEventListener('click', () => copyToClipboard(token));
    a2.appendChild(c2);
    f2.appendChild(l2);
    f2.appendChild(v2);
    f2.appendChild(a2);

    row.appendChild(f1);
    row.appendChild(f2);
    steps.appendChild(row);

    const hint = document.createElement('div');
    hint.className = 'pw-muted';
    hint.textContent = 'Proofwork sends a HEAD request to your origin. Respond 200 OK and include the header.';
    steps.appendChild(hint);
  } else {
    const hint = document.createElement('div');
    hint.className = 'pw-muted';
    hint.textContent = 'Unknown verification method.';
    steps.appendChild(hint);
  }

  guide.appendChild(steps);
  body.appendChild(guide);

  const actions = document.createElement('div');
  actions.className = 'pw-actions';
  const btnSelect = document.createElement('button');
  btnSelect.type = 'button';
  btnSelect.className = 'pw-btn';
  btnSelect.textContent = 'Use this origin id';
  btnSelect.addEventListener('click', () => {
    $('originId').value = String(origin?.id ?? '');
    toast('Selected origin', 'good');
  });
  const btnCheck = document.createElement('button');
  btnCheck.type = 'button';
  btnCheck.className = 'pw-btn primary';
  btnCheck.textContent = 'Check verification';
  btnCheck.addEventListener('click', () => onCheckOrigin().catch((e) => setStatus('originStatus', String(e), 'bad')));
  actions.appendChild(btnSelect);
  actions.appendChild(btnCheck);
  body.appendChild(actions);
}

function renderOriginsTable(origins) {
  const tbody = $('originsTbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const rows = Array.isArray(origins) ? origins : [];
  for (const o of rows) {
    const tr = document.createElement('tr');

    const status = String(o?.status ?? '');
    const method = String(o?.method ?? '');
    const verifiedAt = toMs(o?.verifiedAt);
    const failure = String(o?.failureReason ?? '').trim();

    const tdStatus = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `pw-chip ${status === 'verified' ? 'good' : status === 'revoked' ? 'faint' : ''}`.trim();
    badge.textContent = status || '—';
    tdStatus.appendChild(badge);

    const tdOrigin = document.createElement('td');
    tdOrigin.className = 'pw-mono';
    tdOrigin.textContent = String(o?.origin ?? '');

    const tdMethod = document.createElement('td');
    tdMethod.className = 'pw-mono';
    tdMethod.textContent = method || '—';

    const tdVerified = document.createElement('td');
    tdVerified.textContent = verifiedAt ? formatAgo(verifiedAt) : '—';

    const tdFail = document.createElement('td');
    tdFail.textContent = failure ? String(failure).slice(0, 80) : '—';

    const tdAction = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'pw-actions';
    const btnUse = document.createElement('button');
    btnUse.type = 'button';
    btnUse.className = 'pw-btn';
    btnUse.textContent = 'Use';
    btnUse.addEventListener('click', () => {
      $('originId').value = String(o?.id ?? '');
      renderOriginGuide(o);
      toast('Selected origin', 'good');
    });
    actions.appendChild(btnUse);

    if (status !== 'revoked') {
      const btnCopy = document.createElement('button');
      btnCopy.type = 'button';
      btnCopy.className = 'pw-btn';
      btnCopy.textContent = 'Copy token';
      btnCopy.addEventListener('click', () => copyToClipboard(String(o?.token ?? '')));
      actions.appendChild(btnCopy);
    }

    tdAction.appendChild(actions);

    tr.appendChild(tdStatus);
    tr.appendChild(tdOrigin);
    tr.appendChild(tdMethod);
    tr.appendChild(tdVerified);
    tr.appendChild(tdFail);
    tr.appendChild(tdAction);
    tbody.appendChild(tr);
  }

  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'pw-muted';
    td.textContent = 'No origins yet. Add one above.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

async function api(path, { method = 'GET', token, body, csrf } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const unsafe = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method).toUpperCase());
  if (unsafe && csrf) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { res, json };
}

async function onLogin() {
  setStatus('loginStatus', '', null);
  const email = $('email').value.trim();
  const password = $('password').value;
  const { res, json } = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  $('loginOut').textContent = pretty(json);
  if (!res.ok) {
    setStatus('loginStatus', `login failed (${res.status})`, 'bad');
    return;
  }
  if (json?.csrfToken) setCsrfToken(String(json.csrfToken));
  setStatus('loginStatus', `ok orgId=${json.orgId} role=${json.role}`, 'good');
  refreshOnboardingStatus().catch(() => {});
}

async function onRegister() {
  setStatus('regStatus', '', null);
  const orgName = $('regOrgName').value.trim();
  const apiKeyName = $('regApiKeyName').value.trim() || 'default';
  const email = $('regEmail').value.trim();
  const password = $('regPassword').value;
  const { res, json } = await api('/api/org/register', { method: 'POST', body: { orgName, email, password, apiKeyName } });
  $('regOut').textContent = pretty(json);
  if (!res.ok) {
    setStatus('regStatus', `register failed (${res.status})`, 'bad');
    return;
  }
  if (json?.token) setBuyerToken(String(json.token));
  setStatus('regStatus', `ok orgId=${json.orgId} (token saved)`, 'good');
  refreshOnboardingStatus().catch(() => {});
}

async function onCreateKey() {
  setStatus('keyStatus', '', null);
  const name = $('keyName').value.trim() || 'portal';
  const csrf = getCsrfToken();
  const { res, json } = await api('/api/session/api-keys', { method: 'POST', csrf, body: { name } });
  $('keyOut').textContent = pretty(json);
  if (!res.ok) {
    setStatus('keyStatus', `create key failed (${res.status})`, 'bad');
    return;
  }
  if (json?.token) setBuyerToken(json.token);
  setStatus('keyStatus', 'token created and saved', 'good');
  toast('API key created', 'good');
  onListKeys({ silent: true }).catch(() => {});
  refreshOnboardingStatus().catch(() => {});
}

function renderApiKeys(keys) {
  const tbody = $('apiKeysTbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const rows = Array.isArray(keys) ? keys : [];
  for (const k of rows) {
    const tr = document.createElement('tr');
    const revoked = Boolean(k?.revokedAt);
    if (revoked) tr.classList.add('pw-row-muted');

    const tdId = document.createElement('td');
    tdId.className = 'pw-mono';
    tdId.textContent = String(k?.id ?? '');

    const tdName = document.createElement('td');
    tdName.textContent = String(k?.name ?? '');

    const tdPrefix = document.createElement('td');
    tdPrefix.className = 'pw-mono';
    tdPrefix.textContent = String(k?.keyPrefix ?? '');

    const tdCreated = document.createElement('td');
    tdCreated.textContent = formatAgo(toMs(k?.createdAt));

    const tdLast = document.createElement('td');
    tdLast.textContent = k?.lastUsedAt ? formatAgo(toMs(k.lastUsedAt)) : '—';

    const tdActions = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'pw-actions';

    const btnCopy = document.createElement('button');
    btnCopy.type = 'button';
    btnCopy.className = 'pw-btn';
    btnCopy.textContent = 'Copy id';
    btnCopy.addEventListener('click', () => copyToClipboard(String(k?.id ?? '')));

    actions.appendChild(btnCopy);

    if (!revoked) {
      const btnRevoke = document.createElement('button');
      btnRevoke.type = 'button';
      btnRevoke.className = 'pw-btn danger';
      btnRevoke.textContent = 'Revoke';
      btnRevoke.addEventListener('click', () => {
        $('revokeKeyId').value = String(k?.id ?? '');
        onRevokeKey().catch((e) => setStatus('keyStatus', String(e), 'bad'));
      });
      actions.appendChild(btnRevoke);
    } else {
      const badge = document.createElement('span');
      badge.className = 'pw-badge';
      badge.textContent = 'Revoked';
      actions.appendChild(badge);
    }

    tdActions.appendChild(actions);

    tr.appendChild(tdId);
    tr.appendChild(tdName);
    tr.appendChild(tdPrefix);
    tr.appendChild(tdCreated);
    tr.appendChild(tdLast);
    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  }
}

async function onListKeys({ silent = false } = {}) {
  if (!silent) setStatus('keyStatus', '', null);
  const { res, json } = await api('/api/org/api-keys', { method: 'GET' });
  $('keyOut').textContent = pretty(json);
  if (!res.ok) {
    if (!silent) setStatus('keyStatus', `list keys failed (${res.status})`, 'bad');
    return;
  }
  renderApiKeys(json?.apiKeys);
  if (!silent) setStatus('keyStatus', `ok (${json.apiKeys?.length ?? 0} keys)`, 'good');
}

async function onRevokeKey() {
  setStatus('keyStatus', '', null);
  const csrf = getCsrfToken();
  const id = $('revokeKeyId').value.trim();
  if (!id) return setStatus('keyStatus', 'missing apiKeyId', 'bad');
  const { res, json } = await api(`/api/session/api-keys/${encodeURIComponent(id)}/revoke`, { method: 'POST', csrf });
  $('keyOut').textContent = pretty(json);
  if (!res.ok) return setStatus('keyStatus', `revoke failed (${res.status})`, 'bad');
  setStatus('keyStatus', 'revoked', 'good');
  toast('API key revoked', 'good');
  onListKeys({ silent: true }).catch(() => {});
  refreshOnboardingStatus().catch(() => {});
}

async function onGetPlatformFee() {
  setStatus('pfStatus', '', null);
  const token = $('buyerToken').value.trim();
  const { res, json } = await api('/api/org/platform-fee', { method: 'GET', token: token || undefined });
  $('pfOut').textContent = pretty(json);
  if (!res.ok) {
    setStatus('pfStatus', `load failed (${res.status})`, 'bad');
    return;
  }
  $('pfBps').value = String(json.platformFeeBps ?? 0);
  $('pfWallet').value = String(json.platformFeeWalletAddress ?? '');
  setStatus('pfStatus', 'ok', 'good');
}

async function onSetPlatformFee() {
  setStatus('pfStatus', '', null);
  const token = $('buyerToken').value.trim();
  const csrf = getCsrfToken();
  const platformFeeBps = Number($('pfBps').value);
  const platformFeeWalletAddress = $('pfWallet').value.trim() || null;
  const { res, json } = await api('/api/org/platform-fee', {
    method: 'PUT',
    token: token || undefined,
    csrf,
    body: { platformFeeBps, platformFeeWalletAddress },
  });
  $('pfOut').textContent = pretty(json);
  if (!res.ok) {
    setStatus('pfStatus', `save failed (${res.status})`, 'bad');
    return;
  }
  setStatus('pfStatus', 'saved', 'good');
  refreshOnboardingStatus().catch(() => {});
}

async function onGetCorsAllowlist() {
  setStatus('corsStatus', '', null);
  const token = $('buyerToken').value.trim();
  const { res, json } = await api('/api/org/cors-allow-origins', { method: 'GET', token: token || undefined });
  $('corsOut').textContent = pretty(json);
  if (!res.ok) {
    setStatus('corsStatus', `load failed (${res.status})`, 'bad');
    return;
  }
  const origins = Array.isArray(json?.origins) ? json.origins : [];
  $('corsOrigins').value = origins.join('\n');
  setStatus('corsStatus', 'ok', 'good');
}

async function onSetCorsAllowlist() {
  setStatus('corsStatus', '', null);
  const token = $('buyerToken').value.trim();
  const csrf = getCsrfToken();
  const origins = $('corsOrigins')
    .value.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const { res, json } = await api('/api/org/cors-allow-origins', { method: 'PUT', token: token || undefined, csrf, body: { origins } });
  $('corsOut').textContent = pretty(json);
  if (!res.ok) {
    setStatus('corsStatus', `save failed (${res.status})`, 'bad');
    return;
  }
  setStatus('corsStatus', 'saved', 'good');
  refreshOnboardingStatus().catch(() => {});
}

function parseNullableIntInput(id) {
  const raw = $(id).value.trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

async function onGetQuotas() {
  setStatus('quotaStatus', '', null);
  const token = $('buyerToken').value.trim();
  const { res, json } = await api('/api/org/quotas', { method: 'GET', token: token || undefined });
  $('quotaOut').textContent = pretty(json);
  if (!res.ok) {
    setStatus('quotaStatus', `load failed (${res.status})`, 'bad');
    return;
  }
  $('quotaDailySpend').value = json.dailySpendLimitCents === null || json.dailySpendLimitCents === undefined ? '' : String(json.dailySpendLimitCents);
  $('quotaMonthlySpend').value = json.monthlySpendLimitCents === null || json.monthlySpendLimitCents === undefined ? '' : String(json.monthlySpendLimitCents);
  $('quotaMaxOpenJobs').value = json.maxOpenJobs === null || json.maxOpenJobs === undefined ? '' : String(json.maxOpenJobs);
  setStatus('quotaStatus', 'ok', 'good');
}

async function onSetQuotas() {
  setStatus('quotaStatus', '', null);
  const token = $('buyerToken').value.trim();
  const csrf = getCsrfToken();

  const body = {
    dailySpendLimitCents: parseNullableIntInput('quotaDailySpend'),
    monthlySpendLimitCents: parseNullableIntInput('quotaMonthlySpend'),
    maxOpenJobs: parseNullableIntInput('quotaMaxOpenJobs'),
  };

  const { res, json } = await api('/api/org/quotas', { method: 'PUT', token: token || undefined, csrf, body });
  $('quotaOut').textContent = pretty(json);
  if (!res.ok) return setStatus('quotaStatus', `save failed (${res.status})`, 'bad');
  setStatus('quotaStatus', 'saved', 'good');
  refreshOnboardingStatus().catch(() => {});
}

function onSaveToken() {
  const t = $('buyerToken').value.trim();
  if (!t) return setStatus('keyStatus', 'missing token', 'bad');
  setBuyerToken(t);
  setStatus('keyStatus', 'token saved', 'good');
  toast('Token saved', 'good');
  refreshOnboardingStatus().catch(() => {});
}

async function onAddOrigin() {
  setStatus('originStatus', '', null);
  const token = $('buyerToken').value.trim();
  const csrf = getCsrfToken();

  const origin = $('originUrl').value.trim();
  const method = $('originMethod').value.trim();
  const { res, json } = await api('/api/origins', { method: 'POST', token: token || undefined, csrf, body: { origin, method } });
  $('originOut').textContent = pretty(json);
  if (!res.ok) {
    setStatus('originStatus', `add origin failed (${res.status})`, 'bad');
    return;
  }
  $('originId').value = json.origin?.id || '';
  setStatus('originStatus', `added origin ${json.origin?.id}`, 'good');
  renderOriginGuide(json.origin);
  onListOrigins({ silent: true }).catch(() => {});
  refreshOnboardingStatus().catch(() => {});
}

async function onListOrigins({ silent = false } = {}) {
  if (!silent) setStatus('originStatus', '', null);
  const token = $('buyerToken').value.trim();
  const { res, json } = await api('/api/origins', { method: 'GET', token: token || undefined });
  $('originOut').textContent = pretty(json);
  if (!res.ok) return silent ? undefined : setStatus('originStatus', `list origins failed (${res.status})`, 'bad');
  renderOriginsTable(json?.origins);
  if (!silent) setStatus('originStatus', `ok (${json.origins?.length ?? 0} origins)`, 'good');
}

async function onCheckOrigin() {
  setStatus('originStatus', '', null);
  const token = $('buyerToken').value.trim();
  const csrf = getCsrfToken();
  const id = $('originId').value.trim();
  const { res, json } = await api(`/api/origins/${encodeURIComponent(id)}/check`, { method: 'POST', token: token || undefined, csrf });
  $('originOut').textContent = pretty(json);
  if (!res.ok) return setStatus('originStatus', `check failed (${res.status})`, 'bad');
  setStatus('originStatus', `status=${json.origin?.status}`, 'good');
  renderOriginGuide(json.origin);
  onListOrigins({ silent: true }).catch(() => {});
  refreshOnboardingStatus().catch(() => {});
}

async function onRevokeOrigin() {
  setStatus('originStatus', '', null);
  const token = $('buyerToken').value.trim();
  const csrf = getCsrfToken();
  const id = $('originId').value.trim();
  const { res, json } = await api(`/api/origins/${encodeURIComponent(id)}/revoke`, { method: 'POST', token: token || undefined, csrf });
  $('originOut').textContent = pretty(json);
  if (!res.ok) return setStatus('originStatus', `revoke failed (${res.status})`, 'bad');
  setStatus('originStatus', `status=${json.origin?.status}`, 'good');
  renderOriginGuide(json.origin);
  onListOrigins({ silent: true }).catch(() => {});
  refreshOnboardingStatus().catch(() => {});
}

async function onCreateBounty() {
  setStatus('bountyStatus', '', null);
  const token = $('buyerToken').value.trim();
  const csrf = getCsrfToken();

  const title = $('bTitle').value.trim();
  const description = $('bDesc').value.trim();
  const allowedOrigins = $('bOrigins')
    .value.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const payoutCents = Number($('bPayout').value);
  const fingerprintClassesRequired = $('bFps')
    .value.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const { res, json } = await api('/api/bounties', {
    method: 'POST',
    token: token || undefined,
    csrf,
    body: { title, description, allowedOrigins, payoutCents, requiredProofs: 1, fingerprintClassesRequired },
  });
  $('bountyOut').textContent = pretty(json);
  if (!res.ok) return setStatus('bountyStatus', `create bounty failed (${res.status})`, 'bad');
  $('bountyId').value = json.id || '';
  setStatus('bountyStatus', `created bounty ${json.id}`, 'good');
  refreshOnboardingStatus().catch(() => {});
}

async function onListBounties() {
  setStatus('bountyStatus', '', null);
  const token = $('buyerToken').value.trim();
  const { res, json } = await api('/api/bounties', { method: 'GET', token: token || undefined });
  $('bountyOut').textContent = pretty(json);
  if (!res.ok) return setStatus('bountyStatus', `list bounties failed (${res.status})`, 'bad');
  setStatus('bountyStatus', `ok (${json.bounties?.length ?? 0} bounties)`, 'good');
}

async function onPublish() {
  setStatus('bountyStatus', '', null);
  const token = $('buyerToken').value.trim();
  const csrf = getCsrfToken();
  const id = $('bountyId').value.trim();
  const { res, json } = await api(`/api/bounties/${encodeURIComponent(id)}/publish`, { method: 'POST', token: token || undefined, csrf });
  $('bountyOut').textContent = pretty(json);
  if (!res.ok) return setStatus('bountyStatus', `publish failed (${res.status})`, 'bad');
  setStatus('bountyStatus', `published ${json.id}`, 'good');
  refreshOnboardingStatus().catch(() => {});
}

async function onListOrgApps() {
  setStatus('appsStatus', '', null);
  const token = $('buyerToken').value.trim();
  const { res, json } = await api('/api/org/apps', { method: 'GET', token: token || undefined });
  $('appsOut').textContent = pretty(json);
  if (!res.ok) return setStatus('appsStatus', `list apps failed (${res.status})`, 'bad');
  setStatus('appsStatus', `ok (${json.apps?.length ?? 0} apps)`, 'good');
}

async function onCreateOrgApp() {
  setStatus('appsStatus', '', null);
  const token = $('buyerToken').value.trim();
  const csrf = getCsrfToken();
  const slug = $('appSlug').value.trim();
  const taskType = $('appTaskType').value.trim();
  const name = $('appName').value.trim();
  const dashboardUrl = $('appDashboardUrl').value.trim() || null;

  let defaultDescriptor = undefined;
  const raw = $('appDefaultDescriptor').value.trim();
  if (raw) {
    try {
      defaultDescriptor = JSON.parse(raw);
    } catch {
      return setStatus('appsStatus', 'defaultDescriptor JSON parse error', 'bad');
    }
  }

  const { res, json } = await api('/api/org/apps', {
    method: 'POST',
    token: token || undefined,
    csrf,
    body: { slug, taskType, name, dashboardUrl, public: true, defaultDescriptor },
  });
  $('appsOut').textContent = pretty(json);
  if (!res.ok) return setStatus('appsStatus', `create app failed (${res.status})`, 'bad');
  setStatus('appsStatus', `created app ${json.app?.id || ''}`, 'good');
  refreshOnboardingStatus().catch(() => {});
}

async function onGetEarnings() {
  setStatus('earningsStatus', '', null);
  const token = $('buyerToken').value.trim();
  const { res, json } = await api('/api/org/earnings', { method: 'GET', token: token || undefined });
  $('earningsOut').textContent = pretty(json);
  if (!res.ok) return setStatus('earningsStatus', `earnings failed (${res.status})`, 'bad');
  setStatus('earningsStatus', 'ok', 'good');
}

async function onListPayouts() {
  setStatus('earningsStatus', '', null);
  const token = $('buyerToken').value.trim();
  const status = $('payoutStatusFilter').value.trim();
  const taskType = $('payoutTaskTypeFilter').value.trim();
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (taskType) qs.set('taskType', taskType);
  const { res, json } = await api(`/api/org/payouts?${qs.toString()}`, { method: 'GET', token: token || undefined });
  $('earningsOut').textContent = pretty(json);
  if (!res.ok) return setStatus('earningsStatus', `payouts failed (${res.status})`, 'bad');
  setStatus('earningsStatus', `ok (${json.payouts?.length ?? 0} payouts)`, 'good');
}

async function onCreateDispute() {
  setStatus('disputeStatus', '', null);
  const token = $('buyerToken').value.trim();
  const csrf = getCsrfToken();
  const payoutId = $('disputePayoutId').value.trim();
  const submissionId = $('disputeSubmissionId').value.trim();
  const reason = $('disputeReason').value.trim();
  const body = { reason };
  if (payoutId) body.payoutId = payoutId;
  if (submissionId) body.submissionId = submissionId;
  const { res, json } = await api('/api/org/disputes', { method: 'POST', token: token || undefined, csrf, body });
  $('disputeOut').textContent = pretty(json);
  if (!res.ok) return setStatus('disputeStatus', `open dispute failed (${res.status})`, 'bad');
  $('cancelDisputeId').value = json.dispute?.id || '';
  setStatus('disputeStatus', `opened dispute ${json.dispute?.id || ''}`, 'good');
  refreshOnboardingStatus().catch(() => {});
}

async function onListDisputes() {
  setStatus('disputeStatus', '', null);
  const token = $('buyerToken').value.trim();
  const { res, json } = await api('/api/org/disputes', { method: 'GET', token: token || undefined });
  $('disputeOut').textContent = pretty(json);
  if (!res.ok) return setStatus('disputeStatus', `list disputes failed (${res.status})`, 'bad');
  setStatus('disputeStatus', `ok (${json.disputes?.length ?? 0} disputes)`, 'good');
}

async function onCancelDispute() {
  setStatus('disputeStatus', '', null);
  const token = $('buyerToken').value.trim();
  const csrf = getCsrfToken();
  const id = $('cancelDisputeId').value.trim();
  if (!id) return setStatus('disputeStatus', 'missing disputeId', 'bad');
  const { res, json } = await api(`/api/org/disputes/${encodeURIComponent(id)}/cancel`, { method: 'POST', token: token || undefined, csrf });
  $('disputeOut').textContent = pretty(json);
  if (!res.ok) return setStatus('disputeStatus', `cancel failed (${res.status})`, 'bad');
  setStatus('disputeStatus', 'cancelled', 'good');
  refreshOnboardingStatus().catch(() => {});
}

$('btnLogin').addEventListener('click', () => onLogin().catch((e) => setStatus('loginStatus', String(e), 'bad')));
$('btnRegister').addEventListener('click', () => onRegister().catch((e) => setStatus('regStatus', String(e), 'bad')));
$('btnCreateKey').addEventListener('click', () => onCreateKey().catch((e) => setStatus('keyStatus', String(e), 'bad')));
$('btnListKeys').addEventListener('click', () => onListKeys().catch((e) => setStatus('keyStatus', String(e), 'bad')));
$('btnRevokeKey').addEventListener('click', () => onRevokeKey().catch((e) => setStatus('keyStatus', String(e), 'bad')));
$('btnSaveToken').addEventListener('click', () => onSaveToken());
const btnCopyBuyerToken = $('btnCopyBuyerToken');
if (btnCopyBuyerToken) {
  btnCopyBuyerToken.addEventListener('click', () => copyToClipboard(($('buyerToken')?.value ?? '').trim()));
}

$('btnGetPlatformFee').addEventListener('click', () => onGetPlatformFee().catch((e) => setStatus('pfStatus', String(e), 'bad')));
$('btnSetPlatformFee').addEventListener('click', () => onSetPlatformFee().catch((e) => setStatus('pfStatus', String(e), 'bad')));

$('btnGetCors').addEventListener('click', () => onGetCorsAllowlist().catch((e) => setStatus('corsStatus', String(e), 'bad')));
$('btnSetCors').addEventListener('click', () => onSetCorsAllowlist().catch((e) => setStatus('corsStatus', String(e), 'bad')));

$('btnGetQuotas').addEventListener('click', () => onGetQuotas().catch((e) => setStatus('quotaStatus', String(e), 'bad')));
$('btnSetQuotas').addEventListener('click', () => onSetQuotas().catch((e) => setStatus('quotaStatus', String(e), 'bad')));

$('btnAddOrigin').addEventListener('click', () => onAddOrigin().catch((e) => setStatus('originStatus', String(e), 'bad')));
$('btnListOrigins').addEventListener('click', () => onListOrigins().catch((e) => setStatus('originStatus', String(e), 'bad')));
$('btnCheckOrigin').addEventListener('click', () => onCheckOrigin().catch((e) => setStatus('originStatus', String(e), 'bad')));
$('btnRevokeOrigin').addEventListener('click', () => onRevokeOrigin().catch((e) => setStatus('originStatus', String(e), 'bad')));

$('btnCreateBounty').addEventListener('click', () => onCreateBounty().catch((e) => setStatus('bountyStatus', String(e), 'bad')));
$('btnListBounties').addEventListener('click', () => onListBounties().catch((e) => setStatus('bountyStatus', String(e), 'bad')));
$('btnPublish').addEventListener('click', () => onPublish().catch((e) => setStatus('bountyStatus', String(e), 'bad')));

// Apps / earnings / disputes
$('btnListOrgApps').addEventListener('click', () => onListOrgApps().catch((e) => setStatus('appsStatus', String(e), 'bad')));
$('btnCreateOrgApp').addEventListener('click', () => onCreateOrgApp().catch((e) => setStatus('appsStatus', String(e), 'bad')));
$('btnGetEarnings').addEventListener('click', () => onGetEarnings().catch((e) => setStatus('earningsStatus', String(e), 'bad')));
$('btnListPayouts').addEventListener('click', () => onListPayouts().catch((e) => setStatus('earningsStatus', String(e), 'bad')));
$('btnCreateDispute').addEventListener('click', () => onCreateDispute().catch((e) => setStatus('disputeStatus', String(e), 'bad')));
$('btnListDisputes').addEventListener('click', () => onListDisputes().catch((e) => setStatus('disputeStatus', String(e), 'bad')));
$('btnCancelDispute').addEventListener('click', () => onCancelDispute().catch((e) => setStatus('disputeStatus', String(e), 'bad')));

setBuyerToken(getBuyerToken());
setCsrfToken(getCsrfToken());
renderOriginGuide(null);
refreshOnboardingStatus().catch(() => {});
