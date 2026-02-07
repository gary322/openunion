import { authHeader, copyToClipboard, el, fetchJson, formatAgo, formatBps, formatCents, startPolling, storageGet, storageSet, toast, LS, qs } from '/ui/pw.js';

async function loadDescriptorSchema() {
  const res = await fetch('/contracts/task_descriptor.schema.json', { credentials: 'omit' });
  return res.json();
}

function bytesOf(obj) {
  return new Blob([JSON.stringify(obj)]).size;
}

function setStatus(id, text, kind = '') {
  const elStatus = qs(`#${id}`);
  if (!elStatus) return;
  elStatus.textContent = text || '';
  elStatus.classList.remove('good', 'bad');
  if (kind) elStatus.classList.add(kind);
}

function setText(id, text) {
  const n = qs(`#${id}`);
  if (n) n.textContent = text || '';
}

function safeClone(obj) {
  return JSON.parse(JSON.stringify(obj ?? {}));
}

function setDeep(obj, path, value) {
  const parts = String(path || '').split('.').filter(Boolean);
  if (parts.length < 2) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

function getDeep(obj, path) {
  const parts = String(path || '').split('.').filter(Boolean);
  if (parts.length < 2) return undefined;
  let cur = obj;
  for (const k of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function deleteDeep(obj, path) {
  const parts = String(path || '').split('.').filter(Boolean);
  if (parts.length < 2) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!cur[k] || typeof cur[k] !== 'object') return;
    cur = cur[k];
  }
  delete cur[parts[parts.length - 1]];
}

function normalizeLines(raw) {
  return String(raw ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeOriginClient(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  let u;
  try {
    u = new URL(s);
  } catch {
    return '';
  }
  if (!['http:', 'https:'].includes(String(u.protocol))) return '';
  if (u.username || u.password) return '';
  return `${u.protocol}//${u.host}`;
}

function validateDescriptorShallow(schema, desc) {
  const errs = [];
  if (!desc || typeof desc !== 'object') return ['descriptor must be an object'];
  const req = schema.required || [];
  for (const k of req) {
    if (desc[k] === undefined) errs.push(`missing ${k}`);
  }
  if (schema.properties?.schema_version?.const && desc.schema_version !== schema.properties.schema_version.const) {
    errs.push(`schema_version must be ${schema.properties.schema_version.const}`);
  }
  if (typeof desc.type !== 'string' || desc.type.length < 1 || desc.type.length > 120) {
    errs.push('type must be 1..120 chars');
  }
  const enumTags = schema.properties?.capability_tags?.items?.enum || [];
  if (!Array.isArray(desc.capability_tags) || desc.capability_tags.length < 1) {
    errs.push('capability_tags must be a non-empty array');
  } else {
    for (const t of desc.capability_tags) {
      if (!enumTags.includes(t)) errs.push(`unknown capability tag: ${t}`);
    }
  }
  if (desc.freshness_sla_sec !== undefined) {
    const v = Number(desc.freshness_sla_sec);
    if (!Number.isFinite(v) || v < 1 || v > 86400) errs.push('freshness_sla_sec must be 1..86400');
  }
  return errs;
}

function apiBase() {
  // App pages are typically same-origin; keep this as a single knob for dev.
  return String(window.location.origin || '').replace(/\/$/, '');
}

async function buyerApi(path, { method = 'GET', token, csrf, body } = {}) {
  const unsafe = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method).toUpperCase());
  const headers = { ...authHeader(token) };
  // Session-authenticated calls require CSRF for unsafe methods (browser interactive UX).
  // Token-authenticated calls ignore CSRF (programmatic UX).
  if (unsafe && !token) {
    const t = String(csrf ?? '').trim();
    if (t) headers['X-CSRF-Token'] = t;
  }
  const credentials = token ? 'omit' : 'include';
  return await fetchJson(`${apiBase()}${path}`, { method, headers, body, credentials });
}

function moneyDefaultsFromUiSchema(uiSchema) {
  const b = uiSchema?.bounty_defaults ?? null;
  return {
    payoutCents: Number.isFinite(Number(b?.payout_cents)) ? Number(b.payout_cents) : null,
    requiredProofs: Number.isFinite(Number(b?.required_proofs)) ? Number(b.required_proofs) : null,
  };
}

export async function initAppPage(cfg) {
  const schema = await loadDescriptorSchema();

  const tokenInput = qs('#buyerToken');
  const connectRow = qs('#connectRow');
  const connectedRow = qs('#connectedRow');
  const connectedTokenPrefix = qs('#connectedTokenPrefix');
  const btnDisconnect = qs('#btnDisconnect');
  const btnSaveToken = qs('#btnSaveToken');
  const btnChangeToken = qs('#btnChangeToken');
  const createAfterConnect = qs('#createAfterConnect');
  const templateRow = qs('#templateRow');
  const publishActionbar = qs('#publishActionbar');
  const tabSignIn = qs('#tabSignIn');
  const tabToken = qs('#tabToken');
  const panelSignIn = qs('#panelSignIn');
  const panelToken = qs('#panelToken');
  const loginEmail = qs('#loginEmail');
  const loginPassword = qs('#loginPassword');
  const btnLogin = qs('#btnLogin');
  const loginStatus = qs('#loginStatus');
  const templateSelect = qs('#template');
  const btnApplyTemplate = qs('#btnApplyTemplate');
  const templateCard = qs('#templateCard');
  const templateGrid = qs('#templateGrid');
  const formRoot = qs('#form');
  const originSelect = qs('#originSelect');
  const originSelectWrap = qs('#originSelectWrap');
  const originSingle = qs('#originSingle');
  const originSingleText = qs('#originSingleText');
  const btnRefreshOrigins = qs('#btnRefreshOrigins');
  const linkVerifyOrigins = qs('#linkVerifyOrigins');
  const payoutInput = qs('#payoutCents');
  const proofsInput = qs('#requiredProofs');
  const payoutPill = qs('#payoutPill');
  const payoutPresets = qs('#payoutPresets');
  const payoutBreakdown = qs('#payoutBreakdown');
  const deliverablesList = qs('#deliverablesList');
  const deliverablesSub = qs('#deliverablesSub');
  const deliverablesHelp = qs('#deliverablesHelp');
  const titleInput = qs('#title');
  const btnCreateDraft = qs('#btnCreateDraft');
  const btnCreatePublish = qs('#btnCreatePublish');
  const actionbarTitle = qs('#actionbarTitle');
  const actionbarSub = qs('#actionbarSub');

  const btnRefreshBounties = qs('#btnRefreshBounties');
  const btnAutoRefresh = qs('#btnAutoRefresh');
  const bountiesTbody = qs('#bountiesTbody');
  const jobsTbody = qs('#jobsTbody');
  const monitorGate = qs('#monitorGate');
  const monitorActions = qs('#monitorActions');

  const descriptorOut = qs('#descriptorOut');
  const payloadOut = qs('#payloadOut');

  const appName = String(cfg?.title || cfg?.name || 'App');
  const taskType = String(cfg?.taskType || cfg?.task_type || cfg?.task_type || '');
  const uiSchema = cfg?.uiSchema || {};
  const defaultDescriptor = cfg?.defaultDescriptor || cfg?.default_descriptor || null;
  const appSlug = String(cfg?.slug || '').trim();
  const publicAllowedOriginsRaw = Array.isArray(cfg?.publicAllowedOrigins)
    ? cfg.publicAllowedOrigins
    : Array.isArray(cfg?.public_allowed_origins)
      ? cfg.public_allowed_origins
      : [];
  const publicAllowedOrigins = Array.from(
    new Set(publicAllowedOriginsRaw.map((o) => normalizeOriginClient(o)).filter(Boolean))
  ).sort();
  const publicAllowedOriginsSet = new Set(publicAllowedOrigins);
  const preferredMarketplaceOrigin =
    publicAllowedOrigins.find((o) => o.includes('ebay.com')) ||
    publicAllowedOrigins.find((o) => o.includes('store.steampowered.com')) ||
    publicAllowedOrigins[0] ||
    '';

  function appStorageKey(suffix) {
    const raw = String(appSlug || taskType || appName || 'app')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    return `pw_app_${suffix}_${raw || 'app'}`;
  }

  // Badges (capabilities + type)
  const caps = Array.isArray(defaultDescriptor?.capability_tags) ? defaultDescriptor.capability_tags : Array.isArray(cfg?.defaultCaps) ? cfg.defaultCaps : [];
  setText('appBadges', taskType ? `${taskType} • ${caps.join(', ')}` : caps.join(', '));

  // Token
  const savedToken = storageGet(LS.buyerToken, '');
  if (tokenInput) tokenInput.value = savedToken;

  // If the user needs to verify an origin, keep the return path tight.
  if (linkVerifyOrigins) {
    const next = String(window.location.pathname || '').startsWith('/') ? String(window.location.pathname || '') : '/apps/';
    linkVerifyOrigins.setAttribute('href', `/buyer/onboarding.html?next=${encodeURIComponent(next)}#origin`);
  }

  // Session connect: app pages can also use the buyer cookie session (no token copy/paste).
  // We keep token mode as the programmatic/advanced option.
  let sessionOk = false;
  let sessionEmail = '';
  let sessionProbeReqNo = 0;

  function csrfToken() {
    return String(storageGet(LS.csrfToken, '') || '').trim();
  }

  async function probeSession() {
    const myReq = ++sessionProbeReqNo;
    try {
      const res = await fetchJson(`${apiBase()}/api/auth/session`, { method: 'GET', credentials: 'include' });
      if (myReq !== sessionProbeReqNo) return sessionOk;
      if (!res.ok) {
        sessionOk = false;
        sessionEmail = '';
        return false;
      }
      const csrf = String(res.json?.csrfToken ?? '').trim();
      if (csrf) storageSet(LS.csrfToken, csrf);
      sessionOk = true;
      sessionEmail = String(res.json?.email ?? '').trim();
      return true;
    } catch {
      if (myReq !== sessionProbeReqNo) return sessionOk;
      sessionOk = false;
      sessionEmail = '';
      return false;
    }
  }

  function setLoginStatus(text, kind = '') {
    if (!loginStatus) return;
    loginStatus.textContent = String(text || '');
    loginStatus.classList.remove('good', 'bad');
    if (kind) loginStatus.classList.add(kind);
  }

  function setConnectTab(which) {
    const w = which === 'token' ? 'token' : 'signin';
    const signInOn = w === 'signin';
    if (tabSignIn) {
      tabSignIn.setAttribute('aria-selected', signInOn ? 'true' : 'false');
      tabSignIn.classList.toggle('active', signInOn);
    }
    if (tabToken) {
      tabToken.setAttribute('aria-selected', signInOn ? 'false' : 'true');
      tabToken.classList.toggle('active', !signInOn);
    }
    if (panelSignIn) panelSignIn.hidden = !signInOn;
    if (panelToken) panelToken.hidden = signInOn;
  }

  tabSignIn?.addEventListener('click', () => setConnectTab('signin'));
  tabToken?.addEventListener('click', () => setConnectTab('token'));

  function renderConnectState() {
    const t = String(storageGet(LS.buyerToken, '') || '').trim();
    const connected = Boolean(t) || sessionOk;
    if (connectRow) connectRow.hidden = connected;
    if (connectedRow) connectedRow.hidden = !connected;
    if (createAfterConnect) createAfterConnect.hidden = !connected;
    if (publishActionbar) publishActionbar.hidden = !connected;
    if (monitorGate) monitorGate.hidden = connected;
    if (monitorActions) monitorActions.hidden = !connected;
    if (connectedTokenPrefix) {
      if (t) connectedTokenPrefix.textContent = `${t.slice(0, 10)}…`;
      else connectedTokenPrefix.textContent = sessionEmail ? `${sessionEmail}` : 'session';
    }
  }

  // Render connect state early to avoid UI flicker on navigation.
  renderConnectState();

  btnChangeToken?.addEventListener('click', () => {
    if (connectRow) connectRow.hidden = false;
    if (connectedRow) connectedRow.hidden = true;
    // If they previously used token mode, default them back to the token tab.
    setConnectTab(storageGet(LS.buyerToken, '') ? 'token' : 'signin');
    (storageGet(LS.buyerToken, '') ? tokenInput : loginEmail)?.focus?.();
  });

  btnDisconnect?.addEventListener('click', async () => {
    // Best-effort logout; even if it fails, clear local state so UI is consistent.
    try {
      await fetchJson(`${apiBase()}/api/auth/logout`, { method: 'POST', credentials: 'include' });
    } catch {
      // ignore
    }
    storageSet(LS.buyerToken, '');
    storageSet(LS.csrfToken, '');
    sessionOk = false;
    sessionEmail = '';
    if (tokenInput) tokenInput.value = '';
    setLoginStatus('');
    toast('Disconnected');
    renderConnectState();
    enableAuto(false);
    await refreshOrigins();
    await refreshBounties();
  });

  btnLogin?.addEventListener('click', async () => {
    setLoginStatus('');
    const email = String(loginEmail?.value ?? '').trim();
    const password = String(loginPassword?.value ?? '');
    if (!email || !password) {
      setLoginStatus('Email and password required', 'bad');
      return;
    }
    setLoginStatus('Signing in…');
    const res = await fetchJson(`${apiBase()}/api/auth/login`, { method: 'POST', body: { email, password }, credentials: 'include' });
    if (!res.ok) {
      setLoginStatus(`Sign in failed (${res.status})`, 'bad');
      return;
    }
    if (res.json?.csrfToken) storageSet(LS.csrfToken, String(res.json.csrfToken));
    sessionOk = true;
    sessionEmail = email;
    toast('Signed in', 'good');
    renderConnectState();
    setStatus('createStatus', 'Loading verified origins…');
    await refreshOrigins();
    setStatus('createStatus', '');
    await refreshBounties();
    enableAuto(true);
  });

  btnSaveToken?.addEventListener('click', async () => {
    const t = String(tokenInput?.value ?? '').trim();
    if (!t) return toast('Missing buyer token', 'bad');
    storageSet(LS.buyerToken, t);
    toast('Connected', 'good');
    renderConnectState();
    setStatus('createStatus', 'Loading verified origins…');
    await refreshOrigins();
    setStatus('createStatus', '');
    await refreshBounties();
    enableAuto(true);
  });

  // Templates: power users still have a dropdown in Dev mode, but normal UX is card-based.
  const templates = Array.isArray(uiSchema?.templates) ? uiSchema.templates : [];
  if (templateCard) templateCard.hidden = templates.length <= 1;
  if (templateRow) templateRow.hidden = templates.length <= 0;
  if (templateSelect) {
    templateSelect.replaceChildren(
      el('option', { value: '' }, ['Custom']),
      ...templates.map((t) => el('option', { value: String(t.id) }, [String(t.name || t.id)]))
    );
  }

  // Render friendly form
  const fieldEls = new Map();
  const touchedKeys = new Set();
  let verifiedOriginsCount = 0;
  let availableOriginsCount = 0;
  let originTouched = false;
  let platformFeeBps = 0;
  let templateAutoApplied = false;

  function isMissingValue(v) {
    if (v === undefined || v === null) return true;
    if (typeof v === 'string') return v.trim().length === 0;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'number') return !Number.isFinite(v);
    // boolean and objects count as present.
    return false;
  }

  function validateRequiredFields(descriptor) {
    const missing = [];
    for (const { field, input } of fieldEls.values()) {
      if (!field?.required) {
        input?.removeAttribute?.('aria-invalid');
        continue;
      }
      const target = String(field.target || '').trim();
      if (!target) continue;

      // Required booleans are treated as "present" even if unchecked; the field exists.
      if (String(field.type) === 'boolean') {
        input?.removeAttribute?.('aria-invalid');
        continue;
      }

      const v = getDeep(descriptor, target);
      const missingThis = isMissingValue(v);
      if (missingThis) {
        missing.push({
          key: String(field.key || ''),
          label: String(field.label || field.key || ''),
          input,
        });
        input?.setAttribute?.('aria-invalid', 'true');
      } else {
        input?.removeAttribute?.('aria-invalid');
      }
    }
    return missing;
  }

  function focusFirstMissing(missing) {
    const first = missing?.[0]?.input;
    if (first && typeof first.focus === 'function') first.focus();
  }

  function effectiveBuyerAuth() {
    // Token mode (programmatic) takes priority over session mode (interactive).
    const saved = String(storageGet(LS.buyerToken, '') || '').trim();
    const typed = String(tokenInput?.value ?? '').trim();
    const token = saved || typed;
    if (token) return { mode: 'token', token, csrf: '' };
    const csrf = csrfToken();
    if (csrf && sessionOk) return { mode: 'session', token: '', csrf };
    return { mode: 'none', token: '', csrf: csrf || '' };
  }

  function renderField(field) {
    const type = String(field.type || 'text');
    const key = String(field.key || '');
    const label = String(field.label || key);
    const required = Boolean(field.required);
    const placeholder = field.placeholder ? String(field.placeholder) : '';
    const help = field.help ? String(field.help) : '';
    const advanced = Boolean(field.advanced);
    const hasDefault = field.default !== undefined && field.default !== null;

    const wrap = document.createElement('div');
    wrap.className = `pw-field ${advanced ? 'pw-dev' : ''}`.trim();

    const lab = document.createElement('label');
    lab.textContent = label + (required ? ' *' : '');
    wrap.appendChild(lab);

    let input;
    if (type === 'textarea') {
      input = document.createElement('textarea');
      input.className = 'pw-textarea';
      if (placeholder) input.placeholder = placeholder;
    } else if (type === 'select') {
      input = document.createElement('select');
      input.className = 'pw-select';
      const opts = Array.isArray(field.options) ? field.options : [];
      input.appendChild(el('option', { value: '' }, ['—']));
      for (const o of opts) input.appendChild(el('option', { value: String(o.value ?? '') }, [String(o.label ?? o.value)]));
    } else if (type === 'number') {
      input = document.createElement('input');
      input.className = 'pw-input';
      input.type = 'number';
      if (field.min !== undefined) input.min = String(field.min);
      if (field.max !== undefined) input.max = String(field.max);
      if (placeholder) input.placeholder = placeholder;
    } else if (type === 'boolean') {
      input = document.createElement('input');
      input.type = 'checkbox';
    } else if (type === 'date') {
      input = document.createElement('input');
      input.className = 'pw-input';
      input.type = 'date';
    } else {
      input = document.createElement('input');
      input.className = 'pw-input';
      input.type = type === 'url' ? 'url' : 'text';
      if (placeholder) input.placeholder = placeholder;
    }

    input.id = `f_${key}`;
    if (required && type !== 'boolean') {
      // Use native required semantics for accessibility (we still gate submission ourselves).
      try {
        input.required = true;
      } catch {
        // ignore
      }
      input.setAttribute('aria-required', 'true');
    }

    // Smart defaults from app schema. This reduces required manual typing.
    if (hasDefault) {
      const dv = field.default;
      if (type === 'boolean') {
        input.checked = Boolean(dv);
      } else {
        const v = Array.isArray(dv) ? dv.join('\n') : String(dv);
        // Only set if currently empty (should be empty on first render).
        if (!String(input.value || '').trim()) input.value = v;
      }
    }
    wrap.appendChild(input);

    if (help) wrap.appendChild(el('div', { class: 'pw-muted', text: help }));
    fieldEls.set(key, { field, input });
    const markTouched = () => {
      if (key) touchedKeys.add(key);
    };
    const onChange = () => {
      markTouched();
      refreshPreview();
    };
    input.addEventListener('input', onChange);
    input.addEventListener('change', onChange);
    return wrap;
  }

  function renderForm() {
    if (!formRoot) return;
    const sections = Array.isArray(uiSchema?.sections) ? uiSchema.sections : [];
    if (!sections.length) {
      formRoot.replaceChildren(
        el('div', { class: 'pw-card soft' }, [
          el('div', { class: 'pw-kicker', text: 'No friendly form configured for this app.' }),
          el('div', { class: 'pw-muted', text: 'Ask the app owner to add an app.ui_schema, or use Developer mode to view the raw descriptor preview.' }),
        ])
      );
      refreshPreview();
      return;
    }

    const nodes = [];
    for (const sec of sections) {
      const card = document.createElement('div');
      card.className = 'pw-card soft';
      const title = el('div', { class: 'pw-card-title' }, [
        el('h3', { text: String(sec.title || '') }),
        el('span', { class: 'pw-kicker', text: String(sec.description || '') }),
      ]);
      card.appendChild(title);

      const grid = document.createElement('div');
      grid.className = 'pw-grid';
      const fields = Array.isArray(sec.fields) ? sec.fields : [];
      for (const f of fields) grid.appendChild(renderField(f));
      card.appendChild(grid);
      nodes.push(card);
    }
    formRoot.replaceChildren(...nodes);
    refreshPreview();
  }

  function recommendedTemplateId() {
    if (!templates.length) return '';
    // Persist the user's last selection per app; it beats any "recommended" hint.
    const saved = String(storageGet(appStorageKey('template'), '') || '').trim();
    if (saved && templates.some((t) => String(t.id) === saved)) return saved;
    const explicit = String(uiSchema?.recommended_template_id || uiSchema?.default_template_id || '').trim();
    if (explicit && templates.some((t) => String(t.id) === explicit)) return explicit;
    const rec = templates.find((t) => Boolean(t?.recommended)) || templates[0];
    return rec ? String(rec.id) : '';
  }

  const templateButtons = new Map();

  function setTemplateUiSelected(tid) {
    const t = String(tid ?? '').trim();
    if (templateSelect) {
      // Keep dropdown in sync for Dev mode and for keyboard users.
      const exists = t && templates.some((x) => String(x.id) === t);
      templateSelect.value = exists ? t : '';
    }
    for (const [id, btn] of templateButtons.entries()) {
      btn.setAttribute('aria-pressed', id === t ? 'true' : 'false');
    }
  }

  function rememberTemplate(tid) {
    const t = String(tid ?? '').trim();
    if (!t) return;
    storageSet(appStorageKey('template'), t);
  }

  function renderTemplateGrid() {
    if (!templateCard || !templateGrid) return;
    templateButtons.clear();
    if (templates.length <= 1) {
      templateCard.hidden = true;
      templateGrid.replaceChildren();
      return;
    }

    templateCard.hidden = false;
    const selected = String(templateSelect?.value || '').trim() || recommendedTemplateId();
    const nodes = [];

    for (const t of templates) {
      const tid = String(t?.id ?? '').trim();
      if (!tid) continue;
      const name = String(t?.name || t?.id || 'Template');
      const isRec = Boolean(t?.recommended) || String(uiSchema?.recommended_template_id || '').trim() === tid;
      const subtitle = String(t?.description || (isRec ? 'Recommended defaults for first publish.' : 'Prefills the form with sensible defaults.'));

      const btn = el('button', { type: 'button', class: 'pw-choice', 'aria-pressed': selected === tid ? 'true' : 'false' }, [
        el('div', { class: 'pw-choice-title' }, [
          el('span', { text: name }),
          isRec ? el('span', { class: 'pw-pill good', text: 'Recommended' }) : el('span', { class: 'pw-pill faint', text: 'Template' }),
        ]),
        el('div', { class: 'pw-choice-sub', text: subtitle }),
      ]);

      btn.addEventListener('click', () => {
        setTemplateUiSelected(tid);
        rememberTemplate(tid);
        applyTemplateByIdInner(tid, { silent: false, overwriteTouched: false });
      });

      templateButtons.set(tid, btn);
      nodes.push(btn);
    }

    templateGrid.replaceChildren(...nodes);
  }

  function applyTemplateByIdInner(tid, { silent, overwriteTouched }) {
    const t = templates.find((x) => String(x.id) === String(tid));
    if (!t) return;
    const preset = t.preset || {};
    for (const [k, v] of Object.entries(preset)) {
      const entry = fieldEls.get(String(k));
      if (!entry) continue;
      if (!overwriteTouched && touchedKeys.has(String(k))) continue;
      const { field, input } = entry;
      if (String(field.type) === 'boolean') {
        input.checked = Boolean(v);
      } else {
        input.value = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('\n') : String(v);
      }
    }
    // Template may set a better default title.
    if (titleInput && !String(titleInput.value || '').trim()) {
      titleInput.value = `${appName} • ${String(t.name || t.id)}`;
    }
    refreshPreview();
    if (!silent) toast(`Applied template: ${String(t.name || t.id)}`, 'good');
  }

  btnApplyTemplate?.addEventListener('click', () => {
    const tid = String(templateSelect?.value ?? '').trim();
    if (!tid) return toast('Pick a template first', 'bad');
    // Dev-mode: overwrite even edited fields.
    applyTemplateByIdInner(tid, { silent: false, overwriteTouched: true });
  });

  function maybeAutoApplyTemplate() {
    if (templateAutoApplied) return;
    if (!templates.length) return;
    const tid = recommendedTemplateId();
    if (!tid) return;

    // Reflect selection in the UI to make the page self-explanatory.
    setTemplateUiSelected(tid);
    applyTemplateByIdInner(tid, { silent: true, overwriteTouched: false });
    templateAutoApplied = true;
  }

  templateSelect?.addEventListener('change', () => {
    const tid = String(templateSelect?.value ?? '').trim();
    if (!tid) return;
    setTemplateUiSelected(tid);
    rememberTemplate(tid);
    applyTemplateByIdInner(tid, { silent: true, overwriteTouched: false });
  });

  // Smart defaults: fill payout/proofs from app schema if provided.
  const moneyDefaults = moneyDefaultsFromUiSchema(uiSchema);
  if (payoutInput && moneyDefaults.payoutCents !== null) payoutInput.value = String(moneyDefaults.payoutCents);
  if (proofsInput && moneyDefaults.requiredProofs !== null) proofsInput.value = String(moneyDefaults.requiredProofs);

  // Payout presets: reduce numeric-thinking. These buttons simply set the underlying inputs.
  const payoutPresetDefs = [];
  const payoutPresetBtns = new Map();

  function roundCents(n) {
    const v = Math.max(0, Math.floor(Number(n || 0)));
    // Round to the nearest 50 cents to keep presets looking intentional.
    return Math.max(100, Math.round(v / 50) * 50);
  }

  function computeWorkerNet(payoutCents) {
    const pc = Math.max(0, Math.floor(Number(payoutCents || 0)));
    const platformCutCents = Math.round((pc * Number(platformFeeBps || 0)) / 10000);
    const workerPortionCents = Math.max(0, pc - platformCutCents);
    const proofworkFeeCents = Math.round(workerPortionCents * 0.01);
    return Math.max(0, workerPortionCents - proofworkFeeCents);
  }

  function buildPayoutPresetDefs() {
    if (payoutPresetDefs.length) return;
    const base = moneyDefaults.payoutCents !== null ? Number(moneyDefaults.payoutCents) : Number(payoutInput?.value ?? 1000);
    const standard = roundCents(Number.isFinite(base) && base > 0 ? base : 1200);
    payoutPresetDefs.push(
      { id: 'small', label: 'Small', cents: roundCents(standard * 0.6) },
      { id: 'standard', label: 'Standard', cents: standard },
      { id: 'premium', label: 'Premium', cents: roundCents(standard * 1.5) }
    );
  }

  function updatePayoutPresetsUi() {
    if (!payoutPresets) return;
    const cur = roundCents(Number(payoutInput?.value ?? 0));
    for (const [id, btn] of payoutPresetBtns.entries()) {
      const def = payoutPresetDefs.find((d) => d.id === id);
      if (!def) continue;
      const pressed = roundCents(def.cents) === cur;
      btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      const net = computeWorkerNet(def.cents);
      const small = btn.querySelector('small');
      if (small) small.textContent = `Net ${formatCents(net)}`;
    }
  }

  function renderPayoutPresets() {
    if (!payoutPresets) return;
    buildPayoutPresetDefs();
    if (!payoutPresetDefs.length) return;

    payoutPresetBtns.clear();
    const nodes = [];
    for (const def of payoutPresetDefs) {
      const btn = el('button', { type: 'button', class: 'pw-preset', 'aria-pressed': 'false' }, [
        `${def.label} · ${formatCents(def.cents)}`,
        el('small', { text: '' }),
      ]);
      btn.addEventListener('click', () => {
        if (payoutInput) payoutInput.value = String(def.cents);
        refreshPreview();
        toast(`Payout: ${formatCents(def.cents)}`, 'good');
      });
      payoutPresetBtns.set(def.id, btn);
      nodes.push(btn);
    }
    payoutPresets.replaceChildren(...nodes);
    updatePayoutPresetsUi();
  }

  function renderDeliverables(descriptor) {
    if (!deliverablesList) return;
    const req = descriptor?.output_spec?.required_artifacts;
    const items = Array.isArray(req) ? req : [];
    if (!items.length) {
      deliverablesList.replaceChildren(el('span', { class: 'pw-chip faint' }, ['No required artifacts']));
      if (deliverablesSub) deliverablesSub.textContent = 'Workers can submit any artifacts. Consider requiring at least one screenshot or log.';
      if (deliverablesHelp) deliverablesHelp.textContent = 'Tip: require a minimal proof (like a screenshot) so verifiers can be deterministic.';
      return;
    }

    deliverablesList.replaceChildren(
      ...items.map((a) => {
        const kind = String(a?.kind || 'artifact');
        const label = String(a?.label || '').trim();
        const parts = [el('span', { class: 'pw-mono', text: kind })];
        if (label && label !== kind) parts.push(el('span', { text: label }));
        return el('span', { class: 'pw-chip' }, parts);
      })
    );
    if (deliverablesSub) deliverablesSub.textContent = 'What workers must submit for this app.';
    if (deliverablesHelp) deliverablesHelp.textContent = 'Tip: keep required artifacts minimal. Proofs are enforced separately.';
  }

  // Preview
  function buildDescriptorFromForm() {
    const base = defaultDescriptor && typeof defaultDescriptor === 'object' ? safeClone(defaultDescriptor) : {};
    base.schema_version = 'v1';
    if (taskType) base.type = taskType;
    if (!Array.isArray(base.capability_tags)) base.capability_tags = caps;
    if (!base.input_spec || typeof base.input_spec !== 'object') base.input_spec = {};
    if (!base.output_spec || typeof base.output_spec !== 'object') base.output_spec = {};

    for (const { field, input } of fieldEls.values()) {
      const target = String(field.target || '');
      if (!target) continue;
      let value;
      if (String(field.type) === 'boolean') value = Boolean(input.checked);
      else if (String(field.type) === 'number') {
        const raw = String(input.value || '').trim();
        value = raw ? Number(raw) : undefined;
        if (value !== undefined && !Number.isFinite(value)) value = undefined;
      } else {
        const raw = String(input.value || '');
        value = raw.trim();
        if (String(field.type) === 'textarea' && String(field.format || '') === 'lines') value = normalizeLines(raw);
        if (value === '') value = undefined;
      }

      if (value === undefined) deleteDeep(base, target);
      else setDeep(base, target, value);
    }

    return base;
  }

  function buildBountyPayload(descriptor) {
    const origin = String(originSelect?.value ?? '').trim();
    const payoutCents = Math.max(0, Math.floor(Number(payoutInput?.value ?? 0)));
    const requiredProofs = Math.max(1, Math.floor(Number(proofsInput?.value ?? 1)));
    const title = String(titleInput?.value ?? '').trim() || `${appName} bounty`;
    const description = String(cfg?.description || '').trim() || `${appName} work`;

    return {
      title,
      description,
      allowedOrigins: origin ? [origin] : [],
      payoutCents,
      requiredProofs,
      fingerprintClassesRequired: ['desktop_us'],
      taskDescriptor: descriptor,
    };
  }

  function inferOriginCandidateFromDescriptor(descriptor) {
    const d = descriptor ?? {};
    const inputSpec = d?.input_spec ?? {};

    const vodUrl = typeof inputSpec?.vod_url === 'string' ? inputSpec.vod_url.trim() : '';
    if (vodUrl) {
      const o = normalizeOriginClient(vodUrl);
      if (o) return o;
    }

    const explicitUrl = typeof inputSpec?.url === 'string' ? inputSpec.url.trim() : '';
    if (explicitUrl) {
      const o = normalizeOriginClient(explicitUrl);
      if (o) return o;
    }

    const sites = inputSpec?.sites;
    const firstSite = Array.isArray(sites) ? String(sites[0] ?? '').trim() : typeof sites === 'string' ? normalizeLines(sites)[0] ?? '' : '';
    if (firstSite) {
      const o = normalizeOriginClient(firstSite);
      if (o) return o;
    }

    // Low-effort default for marketplace: if they provide a query, we default to a curated origin
    // (the server will also generate a search URL if none is provided).
    const query = typeof inputSpec?.query === 'string' ? inputSpec.query.trim() : '';
    if (taskType === 'marketplace_drops' && query && preferredMarketplaceOrigin) return preferredMarketplaceOrigin;

    return '';
  }

  function refreshPreview() {
    const d = buildDescriptorFromForm();
    const p = buildBountyPayload(d);
    if (descriptorOut) descriptorOut.textContent = JSON.stringify(d, null, 2);
    if (payloadOut) payloadOut.textContent = JSON.stringify(p, null, 2);
    renderDeliverables(d);

    const missing = validateRequiredFields(d);
    const auth = effectiveBuyerAuth();
    let origin = String(originSelect?.value ?? '').trim();
    const inferredOrigin = inferOriginCandidateFromDescriptor(d);
    if (!originTouched && !origin && inferredOrigin && originSelect) {
      const exists = Array.from(originSelect.options || []).some((o) => String(o?.value ?? '') === inferredOrigin);
      if (exists) {
        originSelect.value = inferredOrigin;
        origin = inferredOrigin;
        storageSet(appStorageKey('origin'), inferredOrigin);
      }
    }
    const descErrs = validateDescriptorShallow(schema, d);
    const hasSupportedOrigins = publicAllowedOrigins.length > 0;
    const ready = auth.mode !== 'none' && (Boolean(origin) || hasSupportedOrigins) && missing.length === 0 && descErrs.length === 0;

    if (btnCreateDraft) btnCreateDraft.disabled = !ready;
    if (btnCreatePublish) btnCreatePublish.disabled = !ready;

    let msg = '';
    let kind = '';
    if (auth.mode === 'none') {
      msg = 'Next: sign in (recommended) or paste an API token.';
    } else if (!origin && !hasSupportedOrigins && verifiedOriginsCount <= 0) {
      msg = 'Next: verify an origin in the Platform console.';
    } else if (!origin && !hasSupportedOrigins && verifiedOriginsCount > 0) {
      msg = 'Next: pick an allowed origin (verified).';
    } else if (missing.length) {
      msg = `Missing required: ${missing.map((m) => m.label || m.key).filter(Boolean).join(', ')}`;
      kind = 'bad';
    } else if (descErrs.length) {
      msg = `Descriptor invalid: ${descErrs.join('; ')}`;
      kind = 'bad';
    } else {
      msg = 'Ready. Create and publish.';
      kind = 'good';
    }
    setStatus('preflightStatus', msg, kind);

    // Payout pill + breakdown (always visible even if the fold is closed).
    const payoutCents = Math.max(0, Math.floor(Number(payoutInput?.value ?? 0)));
    const requiredProofs = Math.max(1, Math.floor(Number(proofsInput?.value ?? 1)));
    const platformCutCents = Math.round((payoutCents * Number(platformFeeBps || 0)) / 10000);
    const workerPortionCents = Math.max(0, payoutCents - platformCutCents);
    const proofworkFeeCents = Math.round(workerPortionCents * 0.01);
    const workerNetCents = Math.max(0, workerPortionCents - proofworkFeeCents);

    if (payoutPill) payoutPill.textContent = `${formatCents(payoutCents)} • ${requiredProofs} proof${requiredProofs === 1 ? '' : 's'}`;
    if (payoutBreakdown) {
      const pf = Number.isFinite(Number(platformFeeBps)) && Number(platformFeeBps) > 0 ? `platform ${formatBps(platformFeeBps)}` : 'platform 0%';
      payoutBreakdown.textContent = `Net to worker ${formatCents(workerNetCents)} (${pf} then Proofwork 1%)`;
    }
    updatePayoutPresetsUi();

    // Action bar: keep the primary CTA visible without scrolling.
    if (actionbarTitle) {
      actionbarTitle.textContent = kind === 'good' ? `Ready: ${formatCents(Number(payoutInput?.value ?? 0))} payout` : 'Create and publish';
    }
    if (actionbarSub) {
      if (kind === 'good') {
        const originHost = origin ? String(origin).replace(/^https?:\/\//, '') : hasSupportedOrigins ? 'supported origins' : '—';
        actionbarSub.textContent = `Origin: ${originHost} • Net to worker ${formatCents(workerNetCents)} (platform ${formatBps(platformFeeBps)} then Proofwork 1%)`;
      } else {
        actionbarSub.textContent = msg;
      }
    }
  }

  // Fee breakdown (optional but helps users understand net payout).
  let platformFeeReqNo = 0;
  async function refreshPlatformFee() {
    const myReq = ++platformFeeReqNo;
    const auth = effectiveBuyerAuth();
    if (auth.mode === 'none') return;
    const res = await buyerApi('/api/org/platform-fee', { token: auth.token, csrf: auth.csrf });
    if (myReq !== platformFeeReqNo) return;
    if (!res.ok) return;
    const bps = Number(res.json?.platformFeeBps ?? 0);
    if (!Number.isFinite(bps) || bps < 0) return;
    platformFeeBps = Math.floor(bps);
  }

  // Origins
  let originsReqNo = 0;
  async function refreshOrigins() {
    const myReq = ++originsReqNo;
    if (!originSelect) return;
    const auth = effectiveBuyerAuth();
    if (auth.mode === 'none') {
      verifiedOriginsCount = 0;
      availableOriginsCount = 0;
      originSelect.replaceChildren(el('option', { value: '' }, ['— connect to publish —']));
      refreshPreview();
      return;
    }
    refreshPlatformFee().catch(() => {});
    const res = await buyerApi('/api/origins', { token: auth.token, csrf: auth.csrf });
    if (myReq !== originsReqNo) return; // stale response; user changed token and reloaded.
    const origins = res.ok && Array.isArray(res.json?.origins) ? res.json.origins : [];
    const verified = origins
      .filter((o) => String(o.status) === 'verified')
      .map((o) => String(o.origin || '').trim())
      .filter(Boolean);
    verifiedOriginsCount = verified.length;

    // Supported (system) origins do not require per-org verification. Merge with verified origins.
    const union = Array.from(new Set([...publicAllowedOrigins, ...verified])).filter(Boolean).sort();
    availableOriginsCount = union.length;

    // Preserve a user-selected origin if they interact while a refresh is in-flight.
    const preserve = String(originSelect.value || '').trim();
    const saved = String(storageGet(appStorageKey('origin'), '') || '').trim();

    originSelect.replaceChildren(el('option', { value: '' }, ['— auto —']), ...union.map((o) => el('option', { value: String(o) }, [String(o)])));

    let chosen = '';
    if (preserve && union.includes(preserve)) chosen = preserve;
    else if (saved && union.includes(saved)) chosen = saved;
    else if (!originTouched) {
      const inferred = inferOriginCandidateFromDescriptor(buildDescriptorFromForm());
      if (inferred && union.includes(inferred)) chosen = inferred;
      else if (union.length === 1) chosen = union[0];
    }

    if (chosen) {
      originSelect.value = chosen;
      storageSet(appStorageKey('origin'), chosen);
    } else {
      originSelect.value = '';
    }

    const single = union.length === 1 && Boolean(chosen);
    if (originSelectWrap) originSelectWrap.hidden = single;
    if (originSingle) originSingle.hidden = !single;
    if (originSingleText) originSingleText.textContent = single ? chosen.replace(/^https?:\/\//, '') : '—';

    if (!res.ok && !publicAllowedOrigins.length) {
      toast('Failed to load origins', 'bad');
    }
    refreshPreview();
  }

  btnRefreshOrigins?.addEventListener('click', refreshOrigins);
  originSelect?.addEventListener('change', () => {
    const v = String(originSelect?.value ?? '').trim();
    originTouched = true;
    if (v) storageSet(appStorageKey('origin'), v);
    refreshPreview();
  });

  // Create bounty
  async function createBounty(publish) {
    const descriptor = buildDescriptorFromForm();
    const missing = validateRequiredFields(descriptor);
    if (missing.length) {
      setStatus('createStatus', `Missing required fields: ${missing.map((m) => m.label || m.key).filter(Boolean).join(', ')}`, 'bad');
      focusFirstMissing(missing);
      return;
    }

    const errs = validateDescriptorShallow(schema, descriptor);
    if (errs.length) {
      setStatus('createStatus', `Descriptor invalid: ${errs.join('; ')}`, 'bad');
      return;
    }
    const auth = effectiveBuyerAuth();
    if (auth.mode === 'none') return setStatus('createStatus', 'Connect first (sign in or token)', 'bad');

    const payload = buildBountyPayload(descriptor);
    if (!payload.allowedOrigins.length && publicAllowedOrigins.length <= 0) {
      return setStatus('createStatus', 'Pick a verified origin (or verify one first)', 'bad');
    }

    setStatus('createStatus', `Creating… (descriptor ${bytesOf(descriptor)} B)`);
    const res = await buyerApi('/api/bounties', { method: 'POST', token: auth.token, csrf: auth.csrf, body: payload });
    if (!res.ok) {
      setStatus('createStatus', `Create failed (${res.status}): ${res.json?.error?.message || ''}`, 'bad');
      return;
    }
    const bountyId = String(res.json?.id ?? '');
    setStatus('createStatus', `Created draft ${bountyId}`, 'good');
    toast('Draft created', 'good');

    if (publish) {
      const pub = await buyerApi(`/api/bounties/${encodeURIComponent(bountyId)}/publish`, { method: 'POST', token: auth.token, csrf: auth.csrf });
      if (!pub.ok) {
        setStatus('createStatus', `Publish failed (${pub.status})`, 'bad');
        return;
      }
      setStatus('createStatus', `Published ${bountyId}`, 'good');
      toast('Published', 'good');
    }

    await refreshBounties();
  }

  btnCreateDraft?.addEventListener('click', () => createBounty(false));
  btnCreatePublish?.addEventListener('click', () => createBounty(true));

  // Monitor tables
  let selectedBountyId = null;

  function renderBountyRow(b) {
    const tr = document.createElement('tr');
    const id = String(b.id || '');
    tr.appendChild(el('td', {}, [String(b.title || id)]));
    tr.appendChild(el('td', { class: 'pw-mono' }, [String(b.status || '')]));
    tr.appendChild(el('td', { class: 'pw-mono' }, [formatCents(b.payoutCents || 0)]));
    tr.appendChild(el('td', { class: 'pw-mono' }, [b.createdAt ? formatAgo(b.createdAt) : '—']));

    const actions = el('td', {}, []);
    const btnJobs = el('button', { type: 'button', class: 'pw-btn', text: 'Jobs' });
    btnJobs.addEventListener('click', async () => {
      selectedBountyId = id;
      await refreshJobs();
    });
    const btnCopy = el('button', { type: 'button', class: 'pw-btn', text: 'Copy' });
    btnCopy.addEventListener('click', () => copyToClipboard(id));
    actions.appendChild(el('div', { class: 'pw-actions' }, [btnJobs, btnCopy]));
    tr.appendChild(actions);
    return tr;
  }

  function renderJobRow(j) {
    const tr = document.createElement('tr');
    const id = String(j.id || '');
    tr.appendChild(el('td', { class: 'pw-mono' }, [id]));
    tr.appendChild(el('td', { class: 'pw-mono' }, [String(j.status || '')]));
    tr.appendChild(el('td', { class: 'pw-mono' }, [String(j.finalVerdict || '—')]));
    tr.appendChild(el('td', { class: 'pw-mono' }, [j.finalQualityScore === null || j.finalQualityScore === undefined ? '—' : String(j.finalQualityScore)]));
    const actions = el('td', {}, []);
    const btnCopy = el('button', { type: 'button', class: 'pw-btn', text: 'Copy' });
    btnCopy.addEventListener('click', () => copyToClipboard(id));
    actions.appendChild(el('div', { class: 'pw-actions' }, [btnCopy]));
    tr.appendChild(actions);
    return tr;
  }

  async function refreshBounties() {
    const auth = effectiveBuyerAuth();
    if (auth.mode === 'none') {
      setStatus('monitorStatus', 'Connect to load bounties.');
      bountiesTbody?.replaceChildren();
      jobsTbody?.replaceChildren();
      return;
    }
    const res = await buyerApi(`/api/bounties?task_type=${encodeURIComponent(taskType)}&page=1&limit=50`, { token: auth.token, csrf: auth.csrf });
    if (!res.ok) {
      setStatus('monitorStatus', `Failed to load bounties (${res.status})`, 'bad');
      return;
    }
    const bounties = Array.isArray(res.json?.bounties) ? res.json.bounties : [];
    bountiesTbody?.replaceChildren(...bounties.map(renderBountyRow));
    setStatus('monitorStatus', bounties.length ? `Loaded ${bounties.length} bounties` : 'No bounties yet.', bounties.length ? 'good' : '');

    if (selectedBountyId && !bounties.some((b) => String(b.id) === selectedBountyId)) {
      selectedBountyId = null;
      jobsTbody?.replaceChildren();
    }
  }

  async function refreshJobs() {
    const auth = effectiveBuyerAuth();
    if (auth.mode === 'none' || !selectedBountyId) return;
    const res = await buyerApi(`/api/bounties/${encodeURIComponent(selectedBountyId)}/jobs?page=1&limit=50`, { token: auth.token, csrf: auth.csrf });
    if (!res.ok) {
      toast(`Failed to load jobs (${res.status})`, 'bad');
      return;
    }
    const jobs = Array.isArray(res.json?.jobs) ? res.json.jobs : [];
    jobsTbody?.replaceChildren(...jobs.map(renderJobRow));
  }

  btnRefreshBounties?.addEventListener('click', refreshBounties);

  // Auto-refresh toggle
  let stopAuto = null;
  function enableAuto(on) {
    if (!btnAutoRefresh) return;
    btnAutoRefresh.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (stopAuto) {
      stopAuto();
      stopAuto = null;
    }
    if (on) {
      stopAuto = startPolling(async () => {
        await refreshBounties();
        await refreshJobs();
      }, { intervalMs: 3500, immediate: true });
    }
  }

  btnAutoRefresh?.addEventListener('click', () => {
    const on = btnAutoRefresh.getAttribute('aria-pressed') !== 'true';
    enableAuto(on);
  });

  // Initial render
  renderForm();
  renderTemplateGrid();
  renderPayoutPresets();
  maybeAutoApplyTemplate();
  if (titleInput && !String(titleInput.value || '').trim()) titleInput.value = `${appName} bounty`;
  refreshPreview();
  await probeSession();
  renderConnectState();

  // Low-effort default: do not start polling or loading until the user is actually connected.
  const auth0 = effectiveBuyerAuth();
  if (auth0.mode !== 'none') {
    await refreshOrigins();
    await refreshBounties();
    enableAuto(true);
  } else {
    enableAuto(false);
  }
}
