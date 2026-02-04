import { authHeader, copyToClipboard, el, fetchJson, formatAgo, storageGet, storageSet, toast, LS, qs } from '/ui/pw.js';

function currentIdFromUrl() {
  const u = new URL(window.location.href);
  const q = String(u.searchParams.get('id') ?? '').trim();
  return q || '';
}

function setIdInUrl(id) {
  const u = new URL(window.location.href);
  if (!id) u.searchParams.delete('id');
  else u.searchParams.set('id', id);
  window.history.replaceState({}, '', u.toString());
}

function renderKvs(obj) {
  const wrap = document.createElement('div');
  wrap.className = 'pw-grid';
  for (const [k, v] of Object.entries(obj || {})) {
    const card = el('div', { class: 'pw-card soft' }, [
      el('div', { class: 'pw-kicker pw-mono', text: k }),
      el('div', { class: 'pw-mono', text: v === null || v === undefined ? '—' : String(v) }),
    ]);
    wrap.appendChild(card);
  }
  return wrap;
}

function linkButton(label, href, kind = '') {
  const a = document.createElement('a');
  a.className = `pw-btn ${kind}`.trim();
  a.href = href;
  a.textContent = label;
  return a;
}

function suggestedLinks(found) {
  const id = String(found?.id ?? '').trim();
  const type = String(found?.type ?? '').trim();
  const slug = String(found?.meta?.slug ?? '').trim();

  const actions = document.createElement('div');
  actions.className = 'pw-actions';

  actions.appendChild(
    el('button', { type: 'button', class: 'pw-btn', text: 'Copy id' }, [])
  );
  actions.querySelector('button')?.addEventListener('click', () => copyToClipboard(id));

  if (type === 'payout') actions.appendChild(linkButton('Open payouts', `/admin/payouts.html?payoutId=${encodeURIComponent(id)}`, 'primary'));
  if (type === 'dispute') actions.appendChild(linkButton('Open disputes', `/admin/disputes.html?disputeId=${encodeURIComponent(id)}`, 'primary'));
  if (type === 'artifact') actions.appendChild(linkButton('Open artifacts', `/admin/artifacts.html?artifactId=${encodeURIComponent(id)}`, 'primary'));
  if (type === 'app') {
    actions.appendChild(linkButton('Apps dashboard', `/admin/apps.html?appId=${encodeURIComponent(id)}`, 'primary'));
    if (slug) actions.appendChild(linkButton('Open app page', `/apps/app/${encodeURIComponent(slug)}/`, ''));
  }
  if (type === 'alarm_notification') actions.appendChild(linkButton('Alerts', `/admin/alerts.html`, 'primary'));

  if (!actions.children.length) actions.appendChild(linkButton('Admin overview', '/admin/', 'primary'));
  return actions;
}

async function resolve(id, token) {
  const res = await fetchJson(`/api/admin/resolve?id=${encodeURIComponent(id)}`, { headers: { ...authHeader(token) } });
  if (!res.ok) return { ok: false, status: res.status, json: res.json };
  if (!res.json?.found) return { ok: true, found: false };
  return { ok: true, found: true, type: res.json.type, meta: res.json.meta || {} };
}

function setStatus(text, kind = '') {
  const status = qs('#status');
  if (!status) return;
  status.textContent = text || '';
  status.classList.remove('good', 'bad');
  if (kind) status.classList.add(kind);
}

function setResultType(text) {
  const elType = qs('#resultType');
  if (elType) elType.textContent = text || '—';
}

function setRaw(obj) {
  const raw = qs('#raw');
  if (raw) raw.textContent = JSON.stringify(obj ?? {}, null, 2);
}

function setResultNode(node) {
  const out = qs('#result');
  if (out) out.replaceChildren(node);
}

async function onFind() {
  const tokenInput = qs('#adminToken');
  const idInput = qs('#id');
  const token = String(tokenInput?.value ?? '').trim();
  const id = String(idInput?.value ?? '').trim();
  if (!token) return setStatus('Missing admin token', 'bad');
  if (!id) return setStatus('Missing id', 'bad');

  storageSet(LS.adminToken, token);
  setIdInUrl(id);
  setStatus('Searching…');

  const res = await resolve(id, token);
  if (!res.ok) {
    setStatus(`Search failed (${res.status})`, 'bad');
    setResultType('—');
    setResultNode(document.createTextNode(''));
    return;
  }
  if (!res.found) {
    setStatus('Not found', 'bad');
    setResultType('—');
    setRaw({ found: false });
    setResultNode(el('div', { class: 'pw-muted', text: 'No matching object found for that id.' }));
    return;
  }

  const found = { id, type: res.type, meta: res.meta };
  setStatus(`Found ${res.type}`, 'good');
  setResultType(String(res.type || ''));
  setRaw(found);

  const meta = res.meta || {};
  const view = document.createElement('div');
  view.appendChild(suggestedLinks(found));
  view.appendChild(renderKvs({ id, type: res.type, ...meta, resolved_at: formatAgo(Date.now()) }));
  setResultNode(view);
}

function onSaveToken() {
  const token = String(qs('#adminToken')?.value ?? '').trim();
  if (!token) return toast('Missing admin token', 'bad');
  storageSet(LS.adminToken, token);
  toast('Saved admin token', 'good');
}

function init() {
  const token = storageGet(LS.adminToken, '');
  const tokenInput = qs('#adminToken');
  if (tokenInput) tokenInput.value = token;

  const idFromUrl = currentIdFromUrl();
  const idInput = qs('#id');
  if (idInput) idInput.value = idFromUrl;

  qs('#btnSaveToken')?.addEventListener('click', onSaveToken);
  qs('#btnFind')?.addEventListener('click', onFind);
  idInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onFind();
  });

  if (idFromUrl && token) onFind();
}

init();

