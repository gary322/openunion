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
  setBuyerToken(json.token);
  setStatus('keyStatus', 'token created and saved', 'good');
}

async function onListKeys() {
  setStatus('keyStatus', '', null);
  const { res, json } = await api('/api/org/api-keys', { method: 'GET' });
  $('keyOut').textContent = pretty(json);
  if (!res.ok) {
    setStatus('keyStatus', `list keys failed (${res.status})`, 'bad');
    return;
  }
  setStatus('keyStatus', `ok (${json.apiKeys?.length ?? 0} keys)`, 'good');
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
}

function onSaveToken() {
  const t = $('buyerToken').value.trim();
  if (!t) return setStatus('keyStatus', 'missing token', 'bad');
  setBuyerToken(t);
  setStatus('keyStatus', 'token saved', 'good');
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
}

async function onListOrigins() {
  setStatus('originStatus', '', null);
  const token = $('buyerToken').value.trim();
  const { res, json } = await api('/api/origins', { method: 'GET', token: token || undefined });
  $('originOut').textContent = pretty(json);
  if (!res.ok) return setStatus('originStatus', `list origins failed (${res.status})`, 'bad');
  setStatus('originStatus', `ok (${json.origins?.length ?? 0} origins)`, 'good');
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
}

$('btnLogin').addEventListener('click', () => onLogin().catch((e) => setStatus('loginStatus', String(e), 'bad')));
$('btnRegister').addEventListener('click', () => onRegister().catch((e) => setStatus('regStatus', String(e), 'bad')));
$('btnCreateKey').addEventListener('click', () => onCreateKey().catch((e) => setStatus('keyStatus', String(e), 'bad')));
$('btnListKeys').addEventListener('click', () => onListKeys().catch((e) => setStatus('keyStatus', String(e), 'bad')));
$('btnRevokeKey').addEventListener('click', () => onRevokeKey().catch((e) => setStatus('keyStatus', String(e), 'bad')));
$('btnSaveToken').addEventListener('click', () => onSaveToken());

$('btnGetPlatformFee').addEventListener('click', () => onGetPlatformFee().catch((e) => setStatus('pfStatus', String(e), 'bad')));
$('btnSetPlatformFee').addEventListener('click', () => onSetPlatformFee().catch((e) => setStatus('pfStatus', String(e), 'bad')));

$('btnGetCors').addEventListener('click', () => onGetCorsAllowlist().catch((e) => setStatus('corsStatus', String(e), 'bad')));
$('btnSetCors').addEventListener('click', () => onSetCorsAllowlist().catch((e) => setStatus('corsStatus', String(e), 'bad')));

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
