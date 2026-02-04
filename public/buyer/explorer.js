import { authHeader, copyToClipboard, el, fetchJson, storageGet, storageSet, toast, LS, qs } from '/ui/pw.js';

function currentIdFromUrl() {
  const u = new URL(window.location.href);
  return String(u.searchParams.get('id') ?? '').trim();
}

function setIdInUrl(id) {
  const u = new URL(window.location.href);
  if (!id) u.searchParams.delete('id');
  else u.searchParams.set('id', id);
  window.history.replaceState({}, '', u.toString());
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

function renderKvs(obj) {
  const wrap = document.createElement('div');
  wrap.className = 'pw-grid';
  for (const [k, v] of Object.entries(obj || {})) {
    wrap.appendChild(
      el('div', { class: 'pw-card soft' }, [
        el('div', { class: 'pw-kicker pw-mono', text: k }),
        el('div', { class: 'pw-mono', text: v === null || v === undefined ? '—' : String(v) }),
      ])
    );
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

  const copy = el('button', { type: 'button', class: 'pw-btn', text: 'Copy id' });
  copy.addEventListener('click', () => copyToClipboard(id));
  actions.appendChild(copy);

  if (type === 'app' && slug) actions.appendChild(linkButton('Open app page', `/apps/app/${encodeURIComponent(slug)}/`, 'primary'));
  actions.appendChild(linkButton('Open platform console', '/buyer/', type ? '' : 'primary'));

  return actions;
}

async function resolve(id, token) {
  const res = await fetchJson(`/api/org/resolve?id=${encodeURIComponent(id)}`, { headers: { ...authHeader(token) } });
  if (!res.ok) return { ok: false, status: res.status, json: res.json };
  if (!res.json?.found) return { ok: true, found: false };
  return { ok: true, found: true, type: res.json.type, meta: res.json.meta || {} };
}

async function onFind() {
  const tokenInput = qs('#buyerToken');
  const idInput = qs('#id');
  const token = String(tokenInput?.value ?? '').trim();
  const id = String(idInput?.value ?? '').trim();
  if (!id) return setStatus('Missing id', 'bad');

  if (token) storageSet(LS.buyerToken, token);
  setIdInUrl(id);

  setStatus('Searching…');
  const res = await resolve(id, token);
  if (!res.ok) {
    setStatus(`Search failed (${res.status})`, 'bad');
    setResultType('—');
    setRaw({ error: res.json });
    setResultNode(el('div', { class: 'pw-muted', text: 'Search failed. Check your token/session.' }));
    return;
  }
  if (!res.found) {
    setStatus('Not found', 'bad');
    setResultType('—');
    setRaw({ found: false });
    setResultNode(el('div', { class: 'pw-muted', text: 'No matching object found for that id (or it belongs to a different org).' }));
    return;
  }

  const found = { id, type: res.type, meta: res.meta };
  setStatus(`Found ${res.type}`, 'good');
  setResultType(String(res.type || ''));
  setRaw(found);

  const view = document.createElement('div');
  view.appendChild(suggestedLinks(found));
  view.appendChild(renderKvs({ id, type: res.type, ...res.meta }));
  setResultNode(view);
}

function onSaveToken() {
  const token = String(qs('#buyerToken')?.value ?? '').trim();
  if (!token) return toast('Missing buyer token', 'bad');
  storageSet(LS.buyerToken, token);
  toast('Saved buyer token', 'good');
}

function init() {
  const token = storageGet(LS.buyerToken, '');
  const tokenInput = qs('#buyerToken');
  if (tokenInput) tokenInput.value = token;

  const idFromUrl = currentIdFromUrl();
  const idInput = qs('#id');
  if (idInput) idInput.value = idFromUrl;

  qs('#btnSaveToken')?.addEventListener('click', onSaveToken);
  qs('#btnFind')?.addEventListener('click', onFind);
  idInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onFind();
  });

  if (idFromUrl && (token || document.cookie)) onFind();
}

init();

