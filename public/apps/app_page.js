import { authHeader, copyToClipboard, el, fetchJson, formatAgo, formatCents, startPolling, storageGet, storageSet, toast, LS, qs } from '/ui/pw.js';

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

async function buyerApi(path, { method = 'GET', token, body } = {}) {
  return await fetchJson(`${apiBase()}${path}`, {
    method,
    headers: { ...authHeader(token) },
    body,
    // Token-authenticated app pages should not depend on cookie sessions.
    credentials: 'omit',
  });
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
  const btnSaveToken = qs('#btnSaveToken');
  const templateSelect = qs('#template');
  const btnApplyTemplate = qs('#btnApplyTemplate');
  const formRoot = qs('#form');
  const originSelect = qs('#originSelect');
  const btnRefreshOrigins = qs('#btnRefreshOrigins');
  const payoutInput = qs('#payoutCents');
  const proofsInput = qs('#requiredProofs');
  const titleInput = qs('#title');
  const btnCreateDraft = qs('#btnCreateDraft');
  const btnCreatePublish = qs('#btnCreatePublish');

  const btnRefreshBounties = qs('#btnRefreshBounties');
  const btnAutoRefresh = qs('#btnAutoRefresh');
  const bountiesTbody = qs('#bountiesTbody');
  const jobsTbody = qs('#jobsTbody');

  const descriptorOut = qs('#descriptorOut');
  const payloadOut = qs('#payloadOut');

  const appName = String(cfg?.title || cfg?.name || 'App');
  const taskType = String(cfg?.taskType || cfg?.task_type || cfg?.task_type || '');
  const uiSchema = cfg?.uiSchema || {};
  const defaultDescriptor = cfg?.defaultDescriptor || cfg?.default_descriptor || null;

  // Badges (capabilities + type)
  const caps = Array.isArray(defaultDescriptor?.capability_tags) ? defaultDescriptor.capability_tags : Array.isArray(cfg?.defaultCaps) ? cfg.defaultCaps : [];
  setText('appBadges', taskType ? `${taskType} • ${caps.join(', ')}` : caps.join(', '));

  // Token
  const savedToken = storageGet(LS.buyerToken, '');
  if (tokenInput) tokenInput.value = savedToken;
  btnSaveToken?.addEventListener('click', async () => {
    const t = String(tokenInput?.value ?? '').trim();
    if (!t) return toast('Missing buyer token', 'bad');
    storageSet(LS.buyerToken, t);
    toast('Saved buyer token', 'good');
    setStatus('createStatus', 'Loading verified origins…');
    await refreshOrigins();
    setStatus('createStatus', '');
    await refreshBounties();
  });

  // Template dropdown
  const templates = Array.isArray(uiSchema?.templates) ? uiSchema.templates : [];
  if (templateSelect) {
    templateSelect.replaceChildren(
      el('option', { value: '' }, ['Custom']),
      ...templates.map((t) => el('option', { value: String(t.id) }, [String(t.name || t.id)]))
    );
  }

  // Render friendly form
  const fieldEls = new Map();
  function renderField(field) {
    const type = String(field.type || 'text');
    const key = String(field.key || '');
    const label = String(field.label || key);
    const required = Boolean(field.required);
    const placeholder = field.placeholder ? String(field.placeholder) : '';
    const help = field.help ? String(field.help) : '';
    const advanced = Boolean(field.advanced);

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
    wrap.appendChild(input);

    if (help) wrap.appendChild(el('div', { class: 'pw-muted', text: help }));
    fieldEls.set(key, { field, input });
    input.addEventListener('input', () => refreshPreview());
    input.addEventListener('change', () => refreshPreview());
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

  function applyTemplateById(tid) {
    const t = templates.find((x) => String(x.id) === String(tid));
    if (!t) return;
    const preset = t.preset || {};
    for (const [k, v] of Object.entries(preset)) {
      const entry = fieldEls.get(String(k));
      if (!entry) continue;
      const { field, input } = entry;
      if (String(field.type) === 'boolean') {
        input.checked = Boolean(v);
      } else {
        input.value = v === null || v === undefined ? '' : String(v);
      }
    }
    // Template may set a better default title.
    if (titleInput && !String(titleInput.value || '').trim()) {
      titleInput.value = `${appName} • ${String(t.name || t.id)}`;
    }
    refreshPreview();
    toast(`Applied template: ${String(t.name || t.id)}`, 'good');
  }

  btnApplyTemplate?.addEventListener('click', () => {
    const tid = String(templateSelect?.value ?? '').trim();
    if (!tid) return toast('Pick a template first', 'bad');
    applyTemplateById(tid);
  });

  // Smart defaults: fill payout/proofs from app schema if provided.
  const moneyDefaults = moneyDefaultsFromUiSchema(uiSchema);
  if (payoutInput && moneyDefaults.payoutCents !== null) payoutInput.value = String(moneyDefaults.payoutCents);
  if (proofsInput && moneyDefaults.requiredProofs !== null) proofsInput.value = String(moneyDefaults.requiredProofs);
  if (titleInput && !String(titleInput.value || '').trim()) titleInput.value = `${appName} bounty`;

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
    const token = String(tokenInput?.value ?? '').trim();
    const origin = String(originSelect?.value ?? '').trim();
    const payoutCents = Math.max(0, Math.floor(Number(payoutInput?.value ?? 0)));
    const requiredProofs = Math.max(1, Math.floor(Number(proofsInput?.value ?? 1)));
    const title = String(titleInput?.value ?? '').trim() || `${appName} bounty`;
    const description = String(cfg?.description || '').trim() || `${appName} work`;

    return {
      token,
      payload: {
        title,
        description,
        allowedOrigins: origin ? [origin] : [],
        payoutCents,
        requiredProofs,
        fingerprintClassesRequired: ['desktop_us'],
        taskDescriptor: descriptor,
      },
    };
  }

  function refreshPreview() {
    const d = buildDescriptorFromForm();
    const p = buildBountyPayload(d).payload;
    if (descriptorOut) descriptorOut.textContent = JSON.stringify(d, null, 2);
    if (payloadOut) payloadOut.textContent = JSON.stringify(p, null, 2);
  }

  // Origins
  let originsReqNo = 0;
  async function refreshOrigins() {
    const myReq = ++originsReqNo;
    const token = String(tokenInput?.value ?? '').trim();
    if (!originSelect) return;
    if (!token) {
      originSelect.replaceChildren(el('option', { value: '' }, ['— paste token to load origins —']));
      return;
    }
    const res = await buyerApi('/api/origins', { token });
    if (myReq !== originsReqNo) return; // stale response; user changed token and reloaded.
    if (!res.ok) {
      originSelect.replaceChildren(el('option', { value: '' }, [`Failed (${res.status})`]));
      toast('Failed to load origins', 'bad');
      return;
    }
    const origins = Array.isArray(res.json?.origins) ? res.json.origins : [];
    const verified = origins.filter((o) => String(o.status) === 'verified');
    // Preserve a user-selected origin if they interact while a refresh is in-flight.
    const preserve = String(originSelect.value || '').trim();
    originSelect.replaceChildren(el('option', { value: '' }, ['— select —']), ...verified.map((o) => el('option', { value: String(o.origin) }, [String(o.origin)])));
    if (preserve && verified.some((o) => String(o.origin) === preserve)) originSelect.value = preserve;
    else if (verified.length === 1) originSelect.value = String(verified[0].origin);
    toast(`Loaded ${verified.length} verified origin(s)`, verified.length ? 'good' : '');
  }

  btnRefreshOrigins?.addEventListener('click', refreshOrigins);
  originSelect?.addEventListener('change', () => refreshPreview());

  // Create bounty
  async function createBounty(publish) {
    const descriptor = buildDescriptorFromForm();
    const errs = validateDescriptorShallow(schema, descriptor);
    if (errs.length) {
      setStatus('createStatus', `Descriptor invalid: ${errs.join('; ')}`, 'bad');
      return;
    }
    const b = buildBountyPayload(descriptor);
    if (!b.token) return setStatus('createStatus', 'Missing buyer token', 'bad');
    if (!b.payload.allowedOrigins.length) return setStatus('createStatus', 'Pick a verified origin (or verify one first)', 'bad');

    setStatus('createStatus', `Creating… (descriptor ${bytesOf(descriptor)} B)`);
    const res = await buyerApi('/api/bounties', { method: 'POST', token: b.token, body: b.payload });
    if (!res.ok) {
      setStatus('createStatus', `Create failed (${res.status}): ${res.json?.error?.message || ''}`, 'bad');
      return;
    }
    const bountyId = String(res.json?.id ?? '');
    setStatus('createStatus', `Created draft ${bountyId}`, 'good');
    toast('Draft created', 'good');

    if (publish) {
      const pub = await buyerApi(`/api/bounties/${encodeURIComponent(bountyId)}/publish`, { method: 'POST', token: b.token });
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
    const token = String(tokenInput?.value ?? '').trim();
    if (!token) {
      setStatus('monitorStatus', 'Paste a buyer token to load bounties.');
      bountiesTbody?.replaceChildren();
      jobsTbody?.replaceChildren();
      return;
    }
    const res = await buyerApi(`/api/bounties?task_type=${encodeURIComponent(taskType)}&page=1&limit=50`, { token });
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
    const token = String(tokenInput?.value ?? '').trim();
    if (!token || !selectedBountyId) return;
    const res = await buyerApi(`/api/bounties/${encodeURIComponent(selectedBountyId)}/jobs?page=1&limit=50`, { token });
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
  refreshPreview();
  await refreshOrigins();
  await refreshBounties();
  enableAuto(true);
}
