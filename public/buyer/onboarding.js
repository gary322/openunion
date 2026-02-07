import { copyToClipboard, el, fetchJson, formatAgo, formatBps, formatCents, storageGet, storageSet, toast, LS } from '/ui/pw.js';

function $(id) {
  return document.getElementById(id);
}

let refreshQueue = Promise.resolve();
let refreshSeq = 0;

function setRefreshing(on) {
  try {
    if (on) document.body.dataset.refreshing = '1';
    else delete document.body.dataset.refreshing;
  } catch {
    // ignore
  }
}

function safeNextPath() {
  // Allow same-origin, path-only redirects. Reject anything that looks like a URL.
  const raw = new URLSearchParams(window.location.search).get('next');
  const p = String(raw ?? '').trim();
  if (!p) return '';
  if (!p.startsWith('/') || p.startsWith('//')) return '';
  if (p.includes('\n') || p.includes('\r')) return '';
  return p;
}

function nextSlugFromPath(p) {
  const m = String(p || '').match(/^\/apps\/app\/([^/]+)\//);
  if (!m) return '';
  try {
    return decodeURIComponent(m[1] || '');
  } catch {
    return m[1] || '';
  }
}

function setStatus(id, text, kind = '') {
  const node = $(id);
  if (!node) return;
  node.textContent = String(text || '');
  node.classList.remove('good', 'bad', 'warn');
  if (kind) node.classList.add(kind);
}

function setText(id, text) {
  const node = $(id);
  if (!node) return;
  node.textContent = String(text ?? '');
}

function normalizeLines(raw) {
  return String(raw ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

let descriptorSchemaPromise = null;
async function loadDescriptorSchema() {
  if (!descriptorSchemaPromise) {
    descriptorSchemaPromise = fetch('/contracts/task_descriptor.schema.json', { credentials: 'omit' }).then((r) => r.json());
  }
  return descriptorSchemaPromise;
}

function bytesOf(obj) {
  return new Blob([JSON.stringify(obj)]).size;
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
  const req = schema?.required || [];
  for (const k of req) {
    if (desc[k] === undefined) errs.push(`missing ${k}`);
  }
  if (schema?.properties?.schema_version?.const && desc.schema_version !== schema.properties.schema_version.const) {
    errs.push(`schema_version must be ${schema.properties.schema_version.const}`);
  }
  if (typeof desc.type !== 'string' || desc.type.length < 1 || desc.type.length > 120) {
    errs.push('type must be 1..120 chars');
  }
  const enumTags = schema?.properties?.capability_tags?.items?.enum || [];
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

function toKebab(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || '';
}

function toSnake(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return s || '';
}

function csrfToken() {
  return String(storageGet(LS.csrfToken, '') || '').trim();
}

function buyerHeaders({ csrf, token } = {}) {
  const headers = {};
  const t = String(token ?? '').trim();
  if (t) headers['Authorization'] = `Bearer ${t}`;
  const c = String(csrf ?? '').trim();
  if (c) headers['X-CSRF-Token'] = c;
  return headers;
}

async function buyerFetch(path, { method = 'GET', body, csrf, token } = {}) {
  const unsafe = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method).toUpperCase());
  const headers = buyerHeaders({ csrf: unsafe ? csrf : undefined, token });
  const credentials = token ? 'omit' : 'include';
  return await fetchJson(path, { method, headers, body, credentials });
}

function setTab(rootId, which) {
  const root = $(rootId);
  if (!root) return;
  const tabs = Array.from(root.querySelectorAll('[role="tab"]'));
  for (const tab of tabs) {
    const controls = tab.getAttribute('aria-controls');
    const on = String(tab.id) === String(which);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.classList.toggle('active', on);
    if (controls) {
      const panel = $(controls);
      if (panel) panel.hidden = !on;
    }
  }
}

function showStep(stepKey) {
  const keys = ['connect', 'origin', 'cors', 'fees', 'app', 'publish'];
  for (const k of keys) {
    const step = $(`step${k.charAt(0).toUpperCase()}${k.slice(1)}`);
    if (step) step.hidden = k !== stepKey;
    const nav = $(`nav${k.charAt(0).toUpperCase()}${k.slice(1)}`);
    if (nav) {
      if (k === stepKey) nav.setAttribute('aria-current', 'page');
      else nav.removeAttribute('aria-current');
    }
  }
}

function badge(id, text, kind = '') {
  const n = $(id);
  if (!n) return;
  n.textContent = String(text ?? '');
  n.classList.remove('good', 'warn', 'bad', 'faint');
  if (kind) n.classList.add(kind);
}

function clearNode(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
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

function renderOriginGuide(rec) {
  const root = $('originGuideBody');
  if (!root) return;
  clearNode(root);

  if (!rec?.origin || !rec?.token) {
    root.appendChild(el('div', { class: 'pw-muted', text: 'Add an origin to see exact instructions.' }));
    return;
  }

  const origin = String(rec.origin);
  const token = String(rec.token);
  const method = String(rec.method || '');

  const items = [];
  if (method === 'dns_txt') {
    const name = originRecordName(origin);
    items.push(el('div', { class: 'pw-kicker', text: 'DNS TXT record' }));
    items.push(el('div', { class: 'pw-muted', text: 'Create a TXT record that contains the token.' }));
    items.push(
      el('div', { class: 'pw-card soft' }, [
        el('div', { class: 'pw-kv' }, [
          el('div', { class: 'pw-muted', text: 'Name' }),
          el('code', { class: 'pw-mono', text: name || '—' }),
          el('button', { class: 'pw-btn', type: 'button', text: 'Copy', 'data-copy': name || '' }),
        ]),
        el('div', { class: 'pw-kv pw-mt-6' }, [
          el('div', { class: 'pw-muted', text: 'Value' }),
          el('code', { class: 'pw-mono', text: token }),
          el('button', { class: 'pw-btn', type: 'button', text: 'Copy', 'data-copy': token }),
        ]),
      ])
    );
  } else if (method === 'http_file') {
    const url = originHttpFileUrl(origin);
    items.push(el('div', { class: 'pw-kicker', text: 'HTTP file' }));
    items.push(el('div', { class: 'pw-muted', text: 'Serve a file at the URL below, containing the token.' }));
    items.push(
      el('div', { class: 'pw-card soft' }, [
        el('div', { class: 'pw-kv' }, [
          el('div', { class: 'pw-muted', text: 'URL' }),
          el('code', { class: 'pw-mono', text: url || '—' }),
          el('button', { class: 'pw-btn', type: 'button', text: 'Copy', 'data-copy': url || '' }),
        ]),
        el('div', { class: 'pw-kv pw-mt-6' }, [
          el('div', { class: 'pw-muted', text: 'Body must contain' }),
          el('code', { class: 'pw-mono', text: token }),
          el('button', { class: 'pw-btn', type: 'button', text: 'Copy', 'data-copy': token }),
        ]),
      ])
    );
  } else if (method === 'header') {
    items.push(el('div', { class: 'pw-kicker', text: 'HTTP header' }));
    items.push(el('div', { class: 'pw-muted', text: 'Respond to a HEAD request with a header that contains the token.' }));
    items.push(
      el('div', { class: 'pw-card soft' }, [
        el('div', { class: 'pw-kv' }, [
          el('div', { class: 'pw-muted', text: 'Header' }),
          el('code', { class: 'pw-mono', text: 'X-Proofwork-Verify' }),
          el('button', { class: 'pw-btn', type: 'button', text: 'Copy', 'data-copy': 'X-Proofwork-Verify' }),
        ]),
        el('div', { class: 'pw-kv pw-mt-6' }, [
          el('div', { class: 'pw-muted', text: 'Value must contain' }),
          el('code', { class: 'pw-mono', text: token }),
          el('button', { class: 'pw-btn', type: 'button', text: 'Copy', 'data-copy': token }),
        ]),
      ])
    );
  } else {
    items.push(el('div', { class: 'pw-muted', text: 'Unknown method.' }));
  }

  root.replaceChildren(...items);

  for (const btn of root.querySelectorAll('button[data-copy]')) {
    btn.addEventListener('click', async () => {
      const v = btn.getAttribute('data-copy') || '';
      if (!v) return;
      await copyToClipboard(v);
    });
  }
}

function buildAppTemplate(templateId, { taskType }) {
  const type = String(taskType ?? '').trim();
  const base = {
    schema_version: 'v1',
    type,
    input_spec: {},
    output_spec: { required_artifacts: [{ kind: 'log', label: 'report' }] },
    freshness_sla_sec: 3600,
  };

  if (templateId === 'github_scan') {
    return {
      defaultDescriptor: {
        ...base,
        capability_tags: ['http', 'llm_summarize', 'screenshot'],
        input_spec: { query: '', language: '', min_stars: 100 },
        output_spec: { required_artifacts: [{ kind: 'screenshot', label: 'repro' }] },
      },
      uiSchema: {
        schema_version: 'v1',
        category: 'Engineering',
        bounty_defaults: { payout_cents: 1200, required_proofs: 1 },
        templates: [{ id: 'default', name: 'Default scan', preset: { language: 'typescript', min_stars: 100 } }],
        sections: [
          {
            id: 'search',
            title: 'Search',
            description: 'What to scan',
            fields: [
              { key: 'query', label: 'Query', type: 'text', required: true, placeholder: 'e.g. payments api', target: 'input_spec.query' },
              { key: 'language', label: 'Language (optional)', type: 'text', placeholder: 'e.g. python', target: 'input_spec.language' },
              { key: 'min_stars', label: 'Min stars', type: 'number', min: 0, placeholder: '100', target: 'input_spec.min_stars' },
            ],
          },
        ],
      },
    };
  }

  if (templateId === 'research_arxiv') {
    return {
      defaultDescriptor: {
        ...base,
        capability_tags: ['http', 'llm_summarize'],
        input_spec: { idea: '', constraints: '', max_results: 30 },
        output_spec: { required_artifacts: [{ kind: 'log', label: 'research_plan' }] },
      },
      uiSchema: {
        schema_version: 'v1',
        category: 'Research',
        bounty_defaults: { payout_cents: 1800, required_proofs: 1 },
        templates: [{ id: 'plan', name: 'Research plan', preset: { max_results: 30 } }],
        sections: [
          {
            id: 'idea',
            title: 'Idea',
            description: 'What you want to explore',
            fields: [
              { key: 'idea', label: 'Idea', type: 'textarea', required: true, placeholder: 'Describe your idea in 1-3 paragraphs.', target: 'input_spec.idea' },
              { key: 'constraints', label: 'Constraints (optional)', type: 'textarea', placeholder: 'Timeline, budget, focus, etc.', target: 'input_spec.constraints' },
              { key: 'max_results', label: 'Max papers', type: 'number', min: 5, max: 200, placeholder: '30', target: 'input_spec.max_results' },
            ],
          },
        ],
      },
    };
  }

  if (templateId === 'marketplace_watch') {
    return {
      defaultDescriptor: {
        ...base,
        capability_tags: ['browser', 'screenshot'],
        input_spec: { url: '', keywords: [] },
        output_spec: { required_artifacts: [{ kind: 'screenshot', label: 'result' }] },
        freshness_sla_sec: 900,
      },
      uiSchema: {
        schema_version: 'v1',
        category: 'Commerce',
        bounty_defaults: { payout_cents: 900, required_proofs: 1 },
        templates: [{ id: 'watch', name: 'Watch a page', preset: {} }],
        sections: [
          {
            id: 'target',
            title: 'Target',
            description: 'What to monitor',
            fields: [
              { key: 'url', label: 'URL', type: 'url', required: true, placeholder: 'https://…', target: 'input_spec.url' },
              { key: 'keywords', label: 'Keywords (one per line)', type: 'textarea', placeholder: 'sale\nin stock\nprice', target: 'input_spec.keywords' },
            ],
          },
        ],
      },
    };
  }

  // generic_http
  return {
    defaultDescriptor: {
      ...base,
      capability_tags: ['http', 'llm_summarize'],
      input_spec: { url: '', question: '' },
      output_spec: { required_artifacts: [{ kind: 'log', label: 'summary' }] },
    },
    uiSchema: {
      schema_version: 'v1',
      category: 'General',
      bounty_defaults: { payout_cents: 1000, required_proofs: 1 },
      templates: [{ id: 'default', name: 'Default', preset: {} }],
      sections: [
        {
          id: 'request',
          title: 'Request',
          description: 'What to fetch and summarize',
          fields: [
            { key: 'url', label: 'URL', type: 'url', required: true, placeholder: 'https://…', target: 'input_spec.url' },
            { key: 'question', label: 'Question (optional)', type: 'textarea', placeholder: 'What should the worker extract?', target: 'input_spec.question' },
          ],
        },
      ],
    },
  };
}

let lastAutoSlug = '';
let lastAutoTaskType = '';

function autoFillAppIds() {
  const name = $('appName')?.value?.trim?.() || '';
  if (!name) return;
  const autoSlug = toKebab(name);
  const autoTask = toSnake(name);

  const slugEl = $('appSlug');
  const taskEl = $('appTaskType');
  if (slugEl) {
    const cur = String(slugEl.value || '').trim();
    if (!cur || cur === lastAutoSlug) slugEl.value = autoSlug;
  }
  if (taskEl) {
    const cur = String(taskEl.value || '').trim();
    if (!cur || cur === lastAutoTaskType) taskEl.value = autoTask;
  }
  lastAutoSlug = autoSlug;
  lastAutoTaskType = autoTask;
}

function renderAppsTable(apps) {
  const tbody = $('appsTbody');
  if (!tbody) return;
  clearNode(tbody);
  for (const a of apps || []) {
    const tr = document.createElement('tr');
    const slug = String(a?.slug ?? '');
    const taskType = String(a?.taskType ?? a?.task_type ?? '');
    const name = String(a?.name ?? '');
    const isPublic = Boolean(a?.public ?? true);
    const link = slug ? `/apps/app/${encodeURIComponent(slug)}/` : '/apps/';
    tr.appendChild(el('td', { text: name }));
    tr.appendChild(el('td', { class: 'pw-mono', text: slug }));
    tr.appendChild(el('td', { class: 'pw-mono', text: taskType }));
    tr.appendChild(el('td', { text: isPublic ? 'yes' : 'no' }));
    tr.appendChild(
      el('td', {}, [
        el('a', { class: 'pw-link', href: link, text: 'Open' }),
      ])
    );
    tbody.appendChild(tr);
  }
}

function renderOriginsTable(origins, { onCheck, onRevoke, onPick }) {
  const tbody = $('originsTbody');
  if (!tbody) return;
  clearNode(tbody);
  for (const o of origins || []) {
    const tr = document.createElement('tr');
    const status = String(o?.status ?? '');
    const method = String(o?.method ?? '');
    const origin = String(o?.origin ?? '');
    const verifiedAt = o?.verifiedAt ? formatAgo(o.verifiedAt) : '—';
    const failure = String(o?.failureReason ?? '');
    tr.appendChild(el('td', { text: status }));
    tr.appendChild(el('td', { class: 'pw-mono', text: origin }));
    tr.appendChild(el('td', { class: 'pw-mono', text: method }));
    tr.appendChild(el('td', { text: verifiedAt }));
    tr.appendChild(el('td', { class: 'pw-muted', text: failure }));
    const actions = el('td', {}, []);
    const btnPick = el('button', { class: 'pw-btn', type: 'button', text: 'Guide' });
    btnPick.addEventListener('click', () => onPick(o));
    actions.appendChild(btnPick);

    const btnCheck = el('button', { class: 'pw-btn', type: 'button', text: 'Check' });
    btnCheck.disabled = status !== 'pending';
    btnCheck.addEventListener('click', async () => onCheck(o));
    actions.appendChild(btnCheck);

    const btnRevoke = el('button', { class: 'pw-btn danger', type: 'button', text: 'Revoke' });
    btnRevoke.disabled = status === 'revoked';
    btnRevoke.addEventListener('click', async () => onRevoke(o));
    actions.appendChild(btnRevoke);

    tr.appendChild(actions);
    tbody.appendChild(tr);
  }
}

// Publish step: render an app-defined friendly form directly inside the onboarding wizard.
// This keeps the "first publish" path low-effort and avoids sending users to a separate page.
const publishUi = {
  appBySlug: new Map(), // slug -> app record
  selectedSlug: '',
  renderedSlug: '',
  schema: null,
  fieldEls: new Map(), // key -> { field, input }
  touchedKeys: new Set(),
  originTouched: false,
  verifiedOriginsCount: 0,
  platformFeeBps: 0,
  availableOrigins: [],
  publicOrigins: [],
};

function isMissingValue(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'number') return !Number.isFinite(v);
  return false;
}

function validateRequiredFields(fieldEls, descriptor) {
  const missing = [];
  for (const { field, input } of fieldEls.values()) {
    if (!field?.required) {
      input?.removeAttribute?.('aria-invalid');
      continue;
    }
    const target = String(field.target || '').trim();
    if (!target) continue;
    if (String(field.type) === 'boolean') {
      input?.removeAttribute?.('aria-invalid');
      continue;
    }
    const v = getDeep(descriptor, target);
    const missingThis = isMissingValue(v);
    if (missingThis) {
      missing.push({ key: String(field.key || ''), label: String(field.label || field.key || ''), input });
      input?.setAttribute?.('aria-invalid', 'true');
    } else {
      input?.removeAttribute?.('aria-invalid');
    }
  }
  return missing;
}

function focusFirstMissing(missing) {
  const first = missing?.[0]?.input;
  if (!first) return;
  try {
    first.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  } catch {
    // ignore
  }
  try {
    first.focus?.({ preventScroll: true });
  } catch {
    first.focus?.();
  }
}

function moneyDefaultsFromUiSchema(uiSchema) {
  const b = uiSchema?.bounty_defaults ?? null;
  return {
    payoutCents: Number.isFinite(Number(b?.payout_cents)) ? Number(b.payout_cents) : null,
    requiredProofs: Number.isFinite(Number(b?.required_proofs)) ? Number(b.required_proofs) : null,
  };
}

function computeWorkerNetCents(payoutCents, platformFeeBps) {
  const pc = Math.max(0, Math.floor(Number(payoutCents || 0)));
  const platformCutCents = Math.round((pc * Number(platformFeeBps || 0)) / 10000);
  const workerPortionCents = Math.max(0, pc - platformCutCents);
  const proofworkFeeCents = Math.round(workerPortionCents * 0.01);
  return {
    platformCutCents,
    proofworkFeeCents,
    workerNetCents: Math.max(0, workerPortionCents - proofworkFeeCents),
  };
}

const publishPayoutPresets = { defs: [], btns: new Map() };

function roundCents(n) {
  const v = Math.max(0, Math.floor(Number(n || 0)));
  return Math.max(100, Math.round(v / 50) * 50);
}

function renderPublishPayoutPresets(uiSchema) {
  const root = $('publishPayoutPresets');
  const payoutInput = $('publishPayoutCents');
  if (!root || !payoutInput) return;

  publishPayoutPresets.btns.clear();
  publishPayoutPresets.defs = [];

  const money = moneyDefaultsFromUiSchema(uiSchema);
  const base = money.payoutCents !== null ? Number(money.payoutCents) : Number(payoutInput.value ?? 1000);
  const standard = roundCents(Number.isFinite(base) && base > 0 ? base : 1200);
  publishPayoutPresets.defs.push(
    { id: 'small', label: 'Small', cents: roundCents(standard * 0.6) },
    { id: 'standard', label: 'Standard', cents: standard },
    { id: 'premium', label: 'Premium', cents: roundCents(standard * 1.5) }
  );

  const nodes = [];
  for (const def of publishPayoutPresets.defs) {
    const { workerNetCents } = computeWorkerNetCents(def.cents, publishUi.platformFeeBps);
    const btn = el('button', { type: 'button', class: 'pw-preset', 'aria-pressed': 'false' }, [
      `${def.label} · ${formatCents(def.cents)}`,
      el('small', { text: `Net ${formatCents(workerNetCents)}` }),
    ]);
    btn.addEventListener('click', () => {
      payoutInput.value = String(def.cents);
      refreshPublishPreview();
    });
    publishPayoutPresets.btns.set(def.id, btn);
    nodes.push(btn);
  }

  root.replaceChildren(...nodes);
  updatePublishPayoutPresetsUi();
}

function updatePublishPayoutPresetsUi() {
  const payoutInput = $('publishPayoutCents');
  if (!payoutInput) return;
  const cur = roundCents(Number(payoutInput.value ?? 0));
  for (const [id, btn] of publishPayoutPresets.btns.entries()) {
    const def = publishPayoutPresets.defs.find((d) => d.id === id);
    if (!def) continue;
    const pressed = roundCents(def.cents) === cur;
    btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  }
}

function inferOriginCandidateFromDescriptor(descriptor) {
  const d = descriptor ?? {};
  const inputSpec = d?.input_spec ?? {};

  const vodUrl = typeof inputSpec?.vod_url === 'string' ? inputSpec.vod_url.trim() : '';
  if (vodUrl) return normalizeOriginClient(vodUrl);

  const explicitUrl = typeof inputSpec?.url === 'string' ? inputSpec.url.trim() : '';
  if (explicitUrl) return normalizeOriginClient(explicitUrl);

  const sites = inputSpec?.sites;
  const firstSite = Array.isArray(sites) ? String(sites[0] ?? '').trim() : typeof sites === 'string' ? normalizeLines(sites)[0] ?? '' : '';
  if (firstSite) return normalizeOriginClient(firstSite);

  return '';
}

function renderPublishDeliverables(descriptor) {
  const list = $('publishDeliverablesList');
  if (!list) return;
  const sub = $('publishDeliverablesSub');
  const help = $('publishDeliverablesHelp');

  const req = descriptor?.output_spec?.required_artifacts;
  const items = Array.isArray(req) ? req : [];
  if (!items.length) {
    list.replaceChildren(el('span', { class: 'pw-chip faint' }, ['No required artifacts']));
    if (sub) sub.textContent = 'Workers can submit any artifacts. Consider requiring a minimal proof.';
    if (help) help.textContent = 'Tip: require a screenshot or log so verifiers can be deterministic.';
    return;
  }

  list.replaceChildren(
    ...items.map((a) => {
      const kind = String(a?.kind || 'artifact');
      const label = String(a?.label || '').trim();
      const parts = [el('span', { class: 'pw-mono', text: kind })];
      if (label && label !== kind) parts.push(el('span', { text: label }));
      return el('span', { class: 'pw-chip' }, parts);
    })
  );
  if (sub) sub.textContent = 'What workers must submit for this app.';
  if (help) help.textContent = 'Tip: keep required artifacts minimal. Proofs are enforced separately.';
}

function buildDescriptorFromPublishForm(appRec) {
  const taskType = String(appRec?.taskType ?? appRec?.task_type ?? '').trim();
  const defaultDescriptor = appRec?.defaultDescriptor ?? appRec?.default_descriptor ?? {};
  const caps = Array.isArray(defaultDescriptor?.capability_tags) ? defaultDescriptor.capability_tags : [];

  const base = defaultDescriptor && typeof defaultDescriptor === 'object' ? safeClone(defaultDescriptor) : {};
  base.schema_version = 'v1';
  if (taskType) base.type = taskType;
  if (!Array.isArray(base.capability_tags) || base.capability_tags.length === 0) base.capability_tags = caps;
  if (!base.input_spec || typeof base.input_spec !== 'object') base.input_spec = {};
  if (!base.output_spec || typeof base.output_spec !== 'object') base.output_spec = {};

  for (const { field, input } of publishUi.fieldEls.values()) {
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

function renderPublishField(field, { onChange }) {
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

  input.id = `pub_f_${key}`;
  if (required && type !== 'boolean') {
    try {
      input.required = true;
    } catch {
      // ignore
    }
    input.setAttribute('aria-required', 'true');
  }

  if (hasDefault) {
    const dv = field.default;
    if (type === 'boolean') input.checked = Boolean(dv);
    else {
      const v = Array.isArray(dv) ? dv.join('\n') : String(dv);
      if (!String(input.value || '').trim()) input.value = v;
    }
  }

  wrap.appendChild(input);
  if (help) wrap.appendChild(el('div', { class: 'pw-muted', text: help }));

  publishUi.fieldEls.set(key, { field, input });
  const markTouched = () => {
    if (key) publishUi.touchedKeys.add(key);
  };
  const onAny = () => {
    markTouched();
    onChange();
  };
  input.addEventListener('input', onAny);
  input.addEventListener('change', onAny);
  return wrap;
}

function renderPublishForm(appRec) {
  const root = $('publishForm');
  if (!root) return;

  publishUi.fieldEls.clear();
  publishUi.touchedKeys.clear();
  publishUi.originTouched = false;

  // Used by E2E and to avoid user confusion about which app is currently rendered.
  try {
    root.dataset.renderedSlug = String(publishUi.selectedSlug || '').trim();
  } catch {
    // ignore
  }

  const uiSchema = appRec?.uiSchema ?? appRec?.ui_schema ?? {};
  const sections = Array.isArray(uiSchema?.sections) ? uiSchema.sections : [];
  if (!sections.length) {
    root.replaceChildren(
      el('div', { class: 'pw-card soft' }, [
        el('div', { class: 'pw-kicker', text: 'No friendly form configured for this app.' }),
        el('div', { class: 'pw-muted', text: 'Ask the app owner to add an app.ui_schema, or use the app page in Dev mode to view the raw descriptor preview.' }),
      ])
    );
    refreshPublishPreview();
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
    for (const f of fields) grid.appendChild(renderPublishField(f, { onChange: refreshPublishPreview }));
    card.appendChild(grid);
    nodes.push(card);
  }
  root.replaceChildren(...nodes);

  // Smart defaults: payout/proofs + title from app schema.
  const money = moneyDefaultsFromUiSchema(uiSchema);
  const payoutInput = $('publishPayoutCents');
  const proofsInput = $('publishRequiredProofs');
  if (payoutInput && money.payoutCents !== null) payoutInput.value = String(money.payoutCents);
  if (proofsInput && money.requiredProofs !== null) proofsInput.value = String(money.requiredProofs);
  renderPublishPayoutPresets(uiSchema);

  const titleInput = $('publishTitle');
  if (titleInput && !String(titleInput.value || '').trim()) titleInput.value = `${String(appRec?.name || appRec?.slug || 'App')} bounty`;

  publishUi.renderedSlug = publishUi.selectedSlug;
  refreshPublishPreview();
}

function renderPublishOriginsSelect() {
  const sel = $('publishOriginSelect');
  const wrap = $('publishOriginSelectWrap');
  const singleWrap = $('publishOriginSingle');
  const singleText = $('publishOriginSingleText');
  if (!sel) return;

  const preserve = String(sel.value || '').trim();
  const saved = String(storageGet('pw_onboarding_publish_origin', '') || '').trim();

  sel.replaceChildren(el('option', { value: '' }, ['— auto —']), ...publishUi.availableOrigins.map((o) => el('option', { value: String(o) }, [String(o)])));

  let chosen = '';
  if (preserve && publishUi.availableOrigins.includes(preserve)) chosen = preserve;
  else if (saved && publishUi.availableOrigins.includes(saved)) chosen = saved;
  else if (!publishUi.originTouched) {
    const inferred = inferOriginCandidateFromDescriptor(buildDescriptorFromPublishForm(publishUi.appBySlug.get(publishUi.selectedSlug)));
    if (inferred && publishUi.availableOrigins.includes(inferred)) chosen = inferred;
    else if (publishUi.availableOrigins.length === 1) chosen = publishUi.availableOrigins[0];
  }

  if (chosen) {
    sel.value = chosen;
    storageSet('pw_onboarding_publish_origin', chosen);
  } else {
    sel.value = '';
  }

  const single = publishUi.availableOrigins.length === 1 && Boolean(chosen);
  if (wrap) wrap.hidden = single;
  if (singleWrap) singleWrap.hidden = !single;
  if (singleText) singleText.textContent = single ? chosen.replace(/^https?:\/\//, '') : '—';
}

function refreshPublishPreview() {
  const appRec = publishUi.appBySlug.get(publishUi.selectedSlug);
  const preflight = $('publishPreflight');
  const btn = $('btnPublishNow');

  if (!appRec) {
    if (btn) btn.disabled = true;
    if (preflight) preflight.textContent = 'Pick an app to publish.';
    return;
  }

  const schema = publishUi.schema;
  const d = buildDescriptorFromPublishForm(appRec);
  const descriptorOut = $('publishDescriptorOut');
  if (descriptorOut) descriptorOut.textContent = JSON.stringify(d, null, 2);
  renderPublishDeliverables(d);

  const payoutInput = $('publishPayoutCents');
  const proofsInput = $('publishRequiredProofs');
  const payoutCents = Math.max(0, Math.floor(Number(payoutInput?.value ?? 0)));
  const requiredProofs = Math.max(1, Math.floor(Number(proofsInput?.value ?? 1)));

  const pubOrigins = Array.isArray(appRec?.publicAllowedOrigins) ? appRec.publicAllowedOrigins : [];
  publishUi.publicOrigins = Array.from(new Set(pubOrigins.map((o) => normalizeOriginClient(o)).filter(Boolean))).sort();

  // Origins list is populated from refreshAll. If it is missing, keep the UI safe and disable publishing.
  renderPublishOriginsSelect();
  const originSelected = String($('publishOriginSelect')?.value ?? '').trim();
  const hasPublicOrigins = publishUi.publicOrigins.length > 0;
  const originOk = hasPublicOrigins || Boolean(originSelected);

  const missing = validateRequiredFields(publishUi.fieldEls, d);
  const errs = schema ? validateDescriptorShallow(schema, d) : [];

  let msg = '';
  let kind = '';
  const firstMissingLabel = String(missing?.[0]?.label || missing?.[0]?.key || '').trim();
  if (!publishUi.availableOrigins.length && !hasPublicOrigins) {
    msg = 'Next: verify an origin (or pick a built-in app).';
    kind = 'warn';
  } else if (!originOk) {
    msg = 'Next: pick an origin.';
    kind = 'warn';
  } else if (missing.length) {
    msg = firstMissingLabel ? `Next: fill "${firstMissingLabel}".` : 'Next: fill required fields.';
    kind = 'bad';
  } else if (errs.length) {
    msg = `Descriptor invalid: ${String(errs[0] || '').trim()}`;
    kind = 'bad';
  } else {
    msg = 'Ready. Create + publish.';
    kind = 'good';
  }

  if (preflight) {
    preflight.textContent = msg;
    preflight.classList.remove('good', 'bad', 'warn');
    if (kind) preflight.classList.add(kind);
  }

  const pill = $('publishPayoutPill');
  const breakdown = $('publishPayoutBreakdown');
  const { platformCutCents, proofworkFeeCents, workerNetCents } = computeWorkerNetCents(payoutCents, publishUi.platformFeeBps);
  if (pill) pill.textContent = `${formatCents(payoutCents)} • ${requiredProofs} proof${requiredProofs === 1 ? '' : 's'}`;
  if (breakdown) breakdown.textContent = `Net to worker ${formatCents(workerNetCents)} (platform ${formatBps(publishUi.platformFeeBps)} then Proofwork 1%)`;
  updatePublishPayoutPresetsUi();

  const ready = originOk && missing.length === 0 && errs.length === 0 && payoutCents > 0;
  if (btn) btn.disabled = !ready;

  // Hide the result card on edits; it should represent the latest publish action only.
  const resultCard = $('publishResultCard');
  if (resultCard) resultCard.hidden = true;
}

async function createAndPublishFromWizard() {
  const appRec = publishUi.appBySlug.get(publishUi.selectedSlug);
  if (!appRec) return toast('Pick an app first', 'bad');

  if (!publishUi.schema) publishUi.schema = await loadDescriptorSchema();

  const schema = publishUi.schema;
  const descriptor = buildDescriptorFromPublishForm(appRec);
  const missing = validateRequiredFields(publishUi.fieldEls, descriptor);
  if (missing.length) {
    setStatus('publishPreflight', `Missing required: ${String(missing?.[0]?.label || 'field')}`, 'bad');
    focusFirstMissing(missing);
    return;
  }
  const errs = validateDescriptorShallow(schema, descriptor);
  if (errs.length) {
    setStatus('publishPreflight', `Descriptor invalid: ${errs.join('; ')}`, 'bad');
    return;
  }

  const origin = String($('publishOriginSelect')?.value ?? '').trim();
  const pubOrigins = Array.isArray(appRec?.publicAllowedOrigins) ? appRec.publicAllowedOrigins : [];
  const hasPublicOrigins = pubOrigins.length > 0;
  if (!origin && !hasPublicOrigins) {
    setStatus('publishPreflight', 'Pick a verified origin (or verify one first)', 'bad');
    return;
  }

  const payoutCents = Math.max(0, Math.floor(Number($('publishPayoutCents')?.value ?? 0)));
  const requiredProofs = Math.max(1, Math.floor(Number($('publishRequiredProofs')?.value ?? 1)));
  const title = String($('publishTitle')?.value ?? '').trim() || `${String(appRec?.name || appRec?.slug || 'App')} bounty`;
  const description = String(appRec?.description || '').trim() || `${String(appRec?.name || appRec?.slug || 'App')} work`;

  const payload = {
    title,
    description,
    allowedOrigins: origin ? [origin] : [],
    payoutCents,
    requiredProofs,
    fingerprintClassesRequired: ['desktop_us'],
    taskDescriptor: descriptor,
  };

  setStatus('publishPreflight', `Creating… (descriptor ${bytesOf(descriptor)} B)`, 'warn');
  const res = await buyerFetch('/api/bounties', { method: 'POST', csrf: csrfToken(), body: payload });
  if (!res.ok) {
    setStatus('publishPreflight', `Create failed (${res.status}): ${res.json?.error?.message || ''}`, 'bad');
    return;
  }
  const bountyId = String(res.json?.id ?? '');

  const pub = await buyerFetch(`/api/bounties/${encodeURIComponent(bountyId)}/publish`, { method: 'POST', csrf: csrfToken(), body: {} });
  if (!pub.ok) {
    setStatus('publishPreflight', `Publish failed (${pub.status}): ${pub.json?.error?.message || ''}`, 'bad');
    return;
  }

  toast('Published', 'good');
  setStatus('publishPreflight', `Published ${bountyId}`, 'good');

  const resultCard = $('publishResultCard');
  if (resultCard) resultCard.hidden = false;
  const resultText = $('publishResultText');
  if (resultText) resultText.textContent = `Bounty ${bountyId} is live. Bots can start claiming jobs immediately.`;

  const monitorLink = $('publishResultMonitorLink');
  const slug = publishUi.selectedSlug;
  if (monitorLink) monitorLink.setAttribute('href', slug ? `/apps/app/${encodeURIComponent(slug)}/#monitor` : '/apps/');

  await refreshAll();
}

async function probeSession() {
  // Any buyer-auth GET works as a session probe.
  const res = await buyerFetch('/api/org/platform-fee', { method: 'GET' });
  return res.ok;
}

async function refreshAllImpl() {
  const nextPath = safeNextPath();
  const nextSlug = nextSlugFromPath(nextPath);
  const dismissedNext = storageGet('pw_onboarding_next_dismissed', '') === '1';

  // If onboarding started from the catalog ("Create work"), show a fast "continue" CTA even
  // before the user connects. This reduces cognitive load: they always know where they are
  // heading next.
  const nextCard = $('nextAppCard');
  const nextLink = $('nextAppLink');
  const nextText = $('nextAppText');
  if (nextCard && nextPath && !dismissedNext) {
    nextCard.hidden = false;
    if (nextLink) nextLink.setAttribute('href', nextPath);
    if (nextText) nextText.textContent = nextSlug ? `After you connect, open ${nextSlug} to publish work.` : 'After you connect, open the app page to publish work.';
  } else if (nextCard) {
    nextCard.hidden = true;
  }

  const top = $('wizTopStatus');
  if (top) top.textContent = 'Checking status…';

  const sessionOk = await probeSession();

  // Step visibility and connect UX.
  const connectedRow = $('connectConnectedRow');
  const tabs = $('connectTabs');
  if (connectedRow) connectedRow.hidden = !sessionOk;
  if (tabs) tabs.hidden = sessionOk;

  const tokenTools = $('tokenTools');
  if (tokenTools) tokenTools.hidden = !sessionOk;

  const stepOrigin = $('stepOrigin');
  const stepCors = $('stepCors');
  const stepFees = $('stepFees');
  const stepApp = $('stepApp');
  const stepPublish = $('stepPublish');
  if (stepOrigin) stepOrigin.hidden = !sessionOk;
  if (stepCors) stepCors.hidden = !sessionOk;
  if (stepFees) stepFees.hidden = !sessionOk;
  if (stepApp) stepApp.hidden = !sessionOk;
  if (stepPublish) stepPublish.hidden = !sessionOk;

  const emailLabel = $('connectEmail');
  if (emailLabel) emailLabel.textContent = storageGet('pw_buyer_email', 'buyer');

  if (!sessionOk) {
    badge('badgeConnect', '1', 'warn');
    badge('badgeOrigin', '-', 'faint');
    badge('badgeFees', '-', 'faint');
    badge('badgeApp', '-', 'faint');
    badge('badgePublish', '-', 'faint');
    if (top) top.textContent = 'Next: connect (sign in or create org)';
    showStep('connect');
    return;
  }

  badge('badgeConnect', 'Done', 'good');
  if (!publishUi.schema) publishUi.schema = await loadDescriptorSchema();

  // Parallel fetches for the remaining status.
  const [originsRes, corsRes, feeRes, appsRes, publicAppsRes] = await Promise.all([
    buyerFetch('/api/origins', { method: 'GET' }),
    buyerFetch('/api/org/cors-allow-origins', { method: 'GET' }),
    buyerFetch('/api/org/platform-fee', { method: 'GET' }),
    buyerFetch('/api/org/apps?page=1&limit=50', { method: 'GET' }),
    buyerFetch('/api/apps?page=1&limit=200', { method: 'GET' }),
  ]);

  const origins = Array.isArray(originsRes.json?.origins) ? originsRes.json.origins : [];
  const verifiedOriginsList = origins
    .filter((o) => String(o?.status ?? '') === 'verified')
    .map((o) => String(o?.origin ?? '').trim())
    .filter(Boolean);
  const verifiedOrigins = verifiedOriginsList.length;
  badge('badgeOrigin', verifiedOrigins > 0 ? 'Done' : '!', verifiedOrigins > 0 ? 'good' : 'warn');
  publishUi.verifiedOriginsCount = verifiedOrigins;

  const feeBps = Number(feeRes.json?.platformFeeBps ?? 0);
  const feeWallet = String(feeRes.json?.platformFeeWalletAddress ?? '').trim();
  const feeOk = Number.isFinite(feeBps) && (feeBps <= 0 || feeWallet.length > 0);
  badge('badgeFees', feeOk ? 'Done' : '!', feeOk ? 'good' : 'warn');
  publishUi.platformFeeBps = Number.isFinite(feeBps) && feeBps >= 0 ? Math.floor(feeBps) : 0;

  const apps = Array.isArray(appsRes.json?.apps) ? appsRes.json.apps : [];
  const publicAppsAll = Array.isArray(publicAppsRes.json?.apps) ? publicAppsRes.json.apps : [];
  const systemApps = publicAppsAll.filter((a) => String(a?.ownerOrgId ?? '') === 'org_system');
  if (apps.length > 0) badge('badgeApp', 'Done', 'good');
  else if (nextPath) badge('badgeApp', 'Optional', 'faint');
  else badge('badgeApp', '!', 'warn');

  // Render origins/apps tables when their steps are visible (and useful even if not active).
  renderOriginsTable(origins, {
    onPick: (o) => renderOriginGuide(o),
    onCheck: async (o) => {
      setStatus('originStatus', 'Checking…');
      const res = await buyerFetch(`/api/origins/${encodeURIComponent(String(o.id))}/check`, { method: 'POST', csrf: csrfToken() });
      if (!res.ok) {
        setStatus('originStatus', res.json?.error?.message || `Failed (${res.status})`, 'bad');
        return;
      }
      setStatus('originStatus', 'Checked.', 'good');
      renderOriginGuide(res.json?.origin || o);
      await refreshAll();
    },
    onRevoke: async (o) => {
      setStatus('originStatus', 'Revoking…');
      const res = await buyerFetch(`/api/origins/${encodeURIComponent(String(o.id))}/revoke`, { method: 'POST', csrf: csrfToken() });
      if (!res.ok) {
        setStatus('originStatus', res.json?.error?.message || `Failed (${res.status})`, 'bad');
        return;
      }
      setStatus('originStatus', 'Revoked.', 'good');
      await refreshAll();
    },
  });

  renderAppsTable(apps);

  // Populate publish app select (your apps first; then built-in apps).
  publishUi.appBySlug.clear();
  for (const a of apps) {
    const slug = String(a?.slug ?? '').trim();
    if (!slug) continue;
    publishUi.appBySlug.set(slug, a);
  }
  for (const a of systemApps) {
    const slug = String(a?.slug ?? '').trim();
    if (!slug) continue;
    if (!publishUi.appBySlug.has(slug)) publishUi.appBySlug.set(slug, a);
  }

  const publishApp = $('publishApp');
  if (publishApp) {
    const cur = String(publishApp.value || '').trim();
    const remembered = String(storageGet('pw_onboarding_publish_slug', '') || '').trim();
    const nextPreferred = nextSlug ? nextSlug : '';
    clearNode(publishApp);

    const groupMine = document.createElement('optgroup');
    groupMine.label = 'Your apps';
    for (const a of apps) {
      const slug = String(a?.slug ?? '').trim();
      if (!slug) continue;
      const opt = document.createElement('option');
      opt.value = slug;
      opt.textContent = String(a?.name ?? slug);
      opt.dataset.slug = slug;
      opt.dataset.taskType = String(a?.taskType ?? '');
      groupMine.appendChild(opt);
    }
    if (groupMine.children.length) publishApp.appendChild(groupMine);

    const groupBuiltIn = document.createElement('optgroup');
    groupBuiltIn.label = 'Built-in apps';
    for (const a of systemApps) {
      const slug = String(a?.slug ?? '').trim();
      if (!slug) continue;
      const opt = document.createElement('option');
      opt.value = slug;
      opt.textContent = String(a?.name ?? slug);
      opt.dataset.slug = slug;
      opt.dataset.taskType = String(a?.taskType ?? '');
      groupBuiltIn.appendChild(opt);
    }
  if (groupBuiltIn.children.length) publishApp.appendChild(groupBuiltIn);

    // Preserve selection.
    const candidates = [cur, remembered, nextPreferred, apps[0]?.slug, systemApps.find((x) => String(x?.slug) === 'github')?.slug, systemApps[0]?.slug]
      .map((s) => String(s ?? '').trim())
      .filter(Boolean);
    const first = candidates.find((s) => publishUi.appBySlug.has(s)) || '';
    if (first) publishApp.value = first;
    publishUi.selectedSlug = String(publishApp.value || '').trim();
    if (publishUi.selectedSlug) storageSet('pw_onboarding_publish_slug', publishUi.selectedSlug);
  }
  {
    const slug = publishUi.selectedSlug;
    const link = slug ? `/apps/app/${encodeURIComponent(slug)}/` : '/apps/';
    const a = $('btnOpenAppPage');
    if (a) a.setAttribute('href', link);
  }
  {
    const selectedApp = publishUi.appBySlug.get(publishUi.selectedSlug);
    const hasPublicOrigins = Array.isArray(selectedApp?.publicAllowedOrigins) && selectedApp.publicAllowedOrigins.length > 0;
    if (verifiedOrigins <= 0 && hasPublicOrigins) badge('badgeOrigin', 'Optional', 'faint');
  }

  // Fee UI prefill (don't fight the user: only fill if empty or default).
  const pfPct = $('pfPct');
  const pfWalletInput = $('pfWallet');
  if (pfPct && !pfPct.dataset.userSet) {
    const pct = Math.max(0, Math.min(20, Math.round(feeBps / 100)));
    pfPct.value = String(pct);
    setText('pfPctLabel', `${pct}%`);
    setText('pfBpsLabel', `${pct * 100} bps`);
  }
  if (pfWalletInput && !pfWalletInput.dataset.userSet) {
    pfWalletInput.value = feeWallet || '';
  }

  // CORS prefill (optional).
  if (corsRes.ok) {
    const corsText = $('corsOrigins');
    if (corsText && !corsText.dataset.userSet) {
      const list = Array.isArray(corsRes.json?.origins) ? corsRes.json.origins : [];
      corsText.value = list.join('\n');
    }
    const count = Array.isArray(corsRes.json?.origins) ? corsRes.json.origins.length : 0;
    badge('badgeCors', count > 0 ? `${count}` : 'Optional', count > 0 ? 'good' : 'faint');
  }

  // Determine next required step.
  let next = 'publish';
  const selectedAppForNext = publishUi.appBySlug.get(publishUi.selectedSlug);
  const selectedHasPublicOrigins =
    Array.isArray(selectedAppForNext?.publicAllowedOrigins) && selectedAppForNext.publicAllowedOrigins.length > 0;
  if (verifiedOrigins <= 0 && !selectedHasPublicOrigins) next = 'origin';
  else if (!feeOk) next = 'fees';
  else if (apps.length <= 0 && !nextPath) next = 'app';
  else next = 'publish';

  if (top) {
    const msg =
      next === 'origin' ? 'Next: verify an origin' :
      next === 'fees' ? 'Next: set your platform cut' :
      next === 'app' ? 'Next: create your first app' :
      'Next: publish work';
    top.textContent = msg;
  }

  // Default to the next step unless user explicitly navigated.
  const hash = String(window.location.hash || '').replace(/^#/, '');
  const want = ['connect', 'origin', 'cors', 'fees', 'app', 'publish'].includes(hash) ? hash : next;
  showStep(want);

  // Publish status (per selected app if possible).
  let publishedCount = 0;
  const selected = publishApp?.selectedOptions?.[0];
  const taskType = selected?.dataset?.taskType ? String(selected.dataset.taskType) : '';
  if (taskType) {
    const res = await buyerFetch(`/api/bounties?page=1&limit=1&status=published&task_type=${encodeURIComponent(taskType)}`, { method: 'GET' });
    if (res.ok) publishedCount = Number(res.json?.total ?? 0) || 0;
  } else {
    const res = await buyerFetch(`/api/bounties?page=1&limit=1&status=published`, { method: 'GET' });
    if (res.ok) publishedCount = Number(res.json?.total ?? 0) || 0;
  }
  badge('badgePublish', publishedCount > 0 ? 'Done' : '!', publishedCount > 0 ? 'good' : 'warn');
  const pubStatus = $('publishStatus');
  if (pubStatus) pubStatus.textContent = publishedCount > 0 ? `Published bounties: ${publishedCount}` : 'No published bounties yet.';

  // Keep publish-step origin choices up to date.
  const normalizedVerified = verifiedOriginsList.map((o) => normalizeOriginClient(o)).filter(Boolean);
  const currentApp = publishUi.appBySlug.get(publishUi.selectedSlug);
  const publicOriginsRaw = Array.isArray(currentApp?.publicAllowedOrigins) ? currentApp.publicAllowedOrigins : [];
  const publicOrigins = Array.from(new Set(publicOriginsRaw.map((o) => normalizeOriginClient(o)).filter(Boolean))).sort();
  publishUi.publicOrigins = publicOrigins;
  publishUi.availableOrigins = Array.from(new Set([...normalizedVerified, ...publicOrigins])).filter(Boolean).sort();

  // Render/refresh the publish form for the selected app.
  if (currentApp && publishUi.renderedSlug !== publishUi.selectedSlug) renderPublishForm(currentApp);
  refreshPublishPreview();
}

async function refreshAll() {
  // Serialize refreshes to avoid races where a late refresh re-renders UI after the user has
  // started interacting (especially on the publish step).
  const seq = ++refreshSeq;
  refreshQueue = refreshQueue.then(
    async () => {
      setRefreshing(true);
      try {
        await refreshAllImpl();
      } finally {
        if (seq === refreshSeq) setRefreshing(false);
      }
    },
    async () => {
      setRefreshing(true);
      try {
        await refreshAllImpl();
      } finally {
        if (seq === refreshSeq) setRefreshing(false);
      }
    }
  );
  return refreshQueue;
}

function wire() {
  // Tabs
  $('tabSignIn')?.addEventListener('click', () => setTab('connectTabs', 'tabSignIn'));
  $('tabRegister')?.addEventListener('click', () => setTab('connectTabs', 'tabRegister'));

  // Connect actions
  $('btnLogin')?.addEventListener('click', async () => {
    setStatus('loginStatus', 'Signing in…');
    const email = String($('loginEmail')?.value ?? '').trim();
    const password = String($('loginPassword')?.value ?? '').trim();
    const res = await fetchJson('/api/auth/login', { method: 'POST', body: { email, password }, credentials: 'include' });
    if (!res.ok) {
      setStatus('loginStatus', res.json?.error?.message || `Failed (${res.status})`, 'bad');
      return;
    }
    storageSet(LS.csrfToken, String(res.json?.csrfToken ?? ''));
    storageSet('pw_buyer_email', String(res.json?.email ?? email));
    setStatus('loginStatus', 'Signed in.', 'good');
    await refreshAll();
  });

  $('btnRegister')?.addEventListener('click', async () => {
    setStatus('regStatus', 'Creating org…');
    const orgName = String($('regOrgName')?.value ?? '').trim();
    const apiKeyName = String($('regApiKeyName')?.value ?? 'default').trim();
    const email = String($('regEmail')?.value ?? '').trim();
    const password = String($('regPassword')?.value ?? '').trim();
    const res = await fetchJson('/api/org/register', { method: 'POST', body: { orgName, apiKeyName, email, password }, credentials: 'omit' });
    const regOut = $('regOut');
    if (regOut) regOut.textContent = JSON.stringify(res.json ?? {}, null, 2);
    if (!res.ok) {
      setStatus('regStatus', res.json?.error?.message || `Failed (${res.status})`, 'bad');
      return;
    }

    const token = String(res.json?.token ?? '').trim();
    if (token) {
      storageSet(LS.buyerToken, token);
      const tokenInput = $('buyerToken');
      if (tokenInput) tokenInput.value = token;
    }

    // Auto-login to establish a session and CSRF token.
    const login = await fetchJson('/api/auth/login', { method: 'POST', body: { email, password }, credentials: 'include' });
    if (!login.ok) {
      setStatus('regStatus', 'Org created, but login failed. Try signing in.', 'warn');
      return;
    }
    storageSet(LS.csrfToken, String(login.json?.csrfToken ?? ''));
    storageSet('pw_buyer_email', String(login.json?.email ?? email));
    setStatus('regStatus', 'Org created and signed in.', 'good');
    await refreshAll();
  });

  $('btnLogout')?.addEventListener('click', async () => {
    await fetchJson('/api/auth/logout', { method: 'POST', body: {}, credentials: 'include' });
    storageSet(LS.csrfToken, '');
    setStatus('loginStatus', '');
    setStatus('regStatus', '');
    toast('Disconnected', 'good');
    await refreshAll();
  });

  // Advanced token tools (session-based).
  $('btnCreateKey')?.addEventListener('click', async () => {
    setStatus('keyStatus', 'Creating API token…');
    const name = String($('keyName')?.value ?? 'portal').trim() || 'portal';
    const res = await buyerFetch('/api/session/api-keys', { method: 'POST', csrf: csrfToken(), body: { name } });
    if (!res.ok) {
      setStatus('keyStatus', res.json?.error?.message || `Failed (${res.status})`, 'bad');
      return;
    }
    const token = String(res.json?.token ?? '').trim();
    if (token) {
      storageSet(LS.buyerToken, token);
      const tokenInput = $('buyerToken');
      if (tokenInput) tokenInput.value = token;
    }
    setStatus('keyStatus', 'Token created.', 'good');
  });

  $('btnCopyBuyerToken')?.addEventListener('click', async () => {
    const token = String($('buyerToken')?.value ?? '').trim();
    if (!token) return toast('No token to copy', 'bad');
    await copyToClipboard(token);
  });

  // Origin actions
  $('btnAddOrigin')?.addEventListener('click', async () => {
    setStatus('originStatus', 'Adding origin…');
    const origin = String($('originUrl')?.value ?? '').trim();
    const method = String($('originMethod')?.value ?? '').trim();
    const res = await buyerFetch('/api/origins', { method: 'POST', csrf: csrfToken(), body: { origin, method } });
    if (!res.ok) {
      setStatus('originStatus', res.json?.error?.message || `Failed (${res.status})`, 'bad');
      return;
    }
    renderOriginGuide(res.json?.origin);
    setStatus('originStatus', 'Origin added. Follow the instructions, then click Check.', 'good');
    await refreshAll();
  });

  $('btnListOrigins')?.addEventListener('click', async () => {
    await refreshAll();
  });

  // CORS allowlist
  $('corsOrigins')?.addEventListener('input', () => {
    const t = $('corsOrigins');
    if (t) t.dataset.userSet = '1';
  });

  $('btnGetCors')?.addEventListener('click', async () => {
    setStatus('corsStatus', 'Loading…');
    const res = await buyerFetch('/api/org/cors-allow-origins', { method: 'GET' });
    if (!res.ok) {
      setStatus('corsStatus', res.json?.error?.message || `Failed (${res.status})`, 'bad');
      return;
    }
    const list = Array.isArray(res.json?.origins) ? res.json.origins : [];
    const t = $('corsOrigins');
    if (t) t.value = list.join('\n');
    setStatus('corsStatus', 'Loaded.', 'good');
  });

  $('btnSetCors')?.addEventListener('click', async () => {
    setStatus('corsStatus', 'Saving…');
    const origins = normalizeLines($('corsOrigins')?.value ?? '');
    const res = await buyerFetch('/api/org/cors-allow-origins', { method: 'PUT', csrf: csrfToken(), body: { origins } });
    if (!res.ok) {
      setStatus('corsStatus', res.json?.error?.message || `Failed (${res.status})`, 'bad');
      return;
    }
    setStatus('corsStatus', 'Saved.', 'good');
    await refreshAll();
  });

  // Fees
  $('pfPct')?.addEventListener('input', () => {
    const elRange = $('pfPct');
    if (!elRange) return;
    elRange.dataset.userSet = '1';
    const pct = Number(elRange.value ?? 0);
    setText('pfPctLabel', `${pct}%`);
    setText('pfBpsLabel', `${pct * 100} bps`);
  });
  $('pfWallet')?.addEventListener('input', () => {
    const w = $('pfWallet');
    if (w) w.dataset.userSet = '1';
  });
  $('btnSetPlatformFee')?.addEventListener('click', async () => {
    setStatus('pfStatus', 'Saving…');
    const pct = Number($('pfPct')?.value ?? 0);
    const bps = Math.max(0, Math.min(10_000, Math.round(pct * 100)));
    const walletRaw = String($('pfWallet')?.value ?? '').trim();
    const body = { platformFeeBps: bps, platformFeeWalletAddress: walletRaw || null };
    const res = await buyerFetch('/api/org/platform-fee', { method: 'PUT', csrf: csrfToken(), body });
    if (!res.ok) {
      setStatus('pfStatus', res.json?.error?.message || `Failed (${res.status})`, 'bad');
      return;
    }
    setStatus('pfStatus', 'Saved.', 'good');
    await refreshAll();
  });

  // Apps
  $('appName')?.addEventListener('input', autoFillAppIds);

  function renderAppTemplateGrid() {
    const grid = $('appTemplateGrid');
    const sel = $('appTemplate');
    if (!grid || !sel) return;

    const cards = [
      { id: 'generic_http', title: 'HTTP fetch', sub: 'Call an endpoint and return a structured summary.' },
      { id: 'marketplace_watch', title: 'Watch a page', sub: 'Open a page, capture a screenshot, and extract signals.' },
      { id: 'research_arxiv', title: 'ArXiv research', sub: 'Turn an idea into a research plan with cited papers.' },
      { id: 'github_scan', title: 'GitHub scan', sub: 'Find similar repos and report licensing + links.' },
    ];

    function setSelected(id) {
      const v = String(id || '').trim();
      if (v) sel.value = v;
      for (const btn of Array.from(grid.querySelectorAll('button[data-template-id]'))) {
        const tid = String(btn.getAttribute('data-template-id') || '');
        btn.setAttribute('aria-pressed', tid === sel.value ? 'true' : 'false');
      }
    }

    const nodes = [];
    for (const c of cards) {
      const { defaultDescriptor, uiSchema } = buildAppTemplate(c.id, { taskType: 'example_task' });
      const caps = Array.isArray(defaultDescriptor?.capability_tags) ? defaultDescriptor.capability_tags : [];
      const category = String(uiSchema?.category || '').trim();

      const btn = el('button', { type: 'button', class: 'pw-choice', 'data-template-id': c.id, 'aria-pressed': 'false' }, [
        el('div', { class: 'pw-choice-title' }, [
          el('span', { text: c.title }),
          el('span', { class: 'pw-pill faint', text: category || 'Template' }),
        ]),
        el('div', { class: 'pw-choice-sub', text: c.sub }),
        el('div', { class: 'pw-chips' }, caps.map((t) => el('span', { class: 'pw-chip faint' }, [t]))),
      ]);
      btn.addEventListener('click', () => {
        setSelected(c.id);
        toast(`Template: ${c.title}`, 'good');
      });
      nodes.push(btn);
    }

    grid.replaceChildren(...nodes);
    setSelected(String(sel.value || 'generic_http'));
    sel.addEventListener('change', () => setSelected(sel.value));
  }

  renderAppTemplateGrid();

  $('btnCreateOrgApp')?.addEventListener('click', async () => {
    setStatus('appsStatus', 'Creating app…');
    const name = String($('appName')?.value ?? '').trim();
    const slug = String($('appSlug')?.value ?? '').trim() || toKebab(name);
    const taskType = String($('appTaskType')?.value ?? '').trim() || toSnake(name);
    const templateId = String($('appTemplate')?.value ?? 'generic_http').trim();
    const { defaultDescriptor, uiSchema } = buildAppTemplate(templateId, { taskType });
    const dashboardUrl = `/apps/app/${encodeURIComponent(slug)}/`;

    const body = { slug, taskType, name, description: null, dashboardUrl, public: true, defaultDescriptor, uiSchema };
    const res = await buyerFetch('/api/org/apps', { method: 'POST', csrf: csrfToken(), body });
    if (!res.ok) {
      setStatus('appsStatus', res.json?.error?.message || `Failed (${res.status})`, 'bad');
      return;
    }
    setStatus('appsStatus', 'App created.', 'good');
    await refreshAll();
  });

  $('btnListOrgApps')?.addEventListener('click', async () => {
    await refreshAll();
  });

  // Publish
  $('publishApp')?.addEventListener('change', async () => {
    const slug = String($('publishApp')?.value ?? '').trim();
    publishUi.selectedSlug = slug;
    publishUi.renderedSlug = '';
    if (slug) storageSet('pw_onboarding_publish_slug', slug);
    const link = slug ? `/apps/app/${encodeURIComponent(slug)}/` : '/apps/';
    const a = $('btnOpenAppPage');
    if (a) a.setAttribute('href', link);
    await refreshAll();
  });

  $('publishOriginSelect')?.addEventListener('change', () => {
    const v = String($('publishOriginSelect')?.value ?? '').trim();
    publishUi.originTouched = true;
    if (v) storageSet('pw_onboarding_publish_origin', v);
    refreshPublishPreview();
  });

  $('btnRefreshPublishOrigins')?.addEventListener('click', async () => {
    await refreshAll();
  });

  $('btnJumpToOrigin')?.addEventListener('click', () => {
    try {
      window.location.hash = '#origin';
    } catch {
      // ignore
    }
    showStep('origin');
  });

  $('publishPayoutCents')?.addEventListener('input', refreshPublishPreview);
  $('publishRequiredProofs')?.addEventListener('input', refreshPublishPreview);
  $('publishTitle')?.addEventListener('input', refreshPublishPreview);

  $('btnPublishNow')?.addEventListener('click', async () => {
    await createAndPublishFromWizard();
  });

  $('btnDismissNextApp')?.addEventListener('click', () => {
    storageSet('pw_onboarding_next_dismissed', '1');
    const nextCard = $('nextAppCard');
    if (nextCard) nextCard.hidden = true;
    toast('Dismissed', 'good');
  });

  $('btnCheckPublish')?.addEventListener('click', async () => {
    await refreshAll();
  });

  // Nav
  $('navConnect')?.addEventListener('click', () => showStep('connect'));
  $('navOrigin')?.addEventListener('click', () => showStep('origin'));
  $('navCors')?.addEventListener('click', () => showStep('cors'));
  $('navFees')?.addEventListener('click', () => showStep('fees'));
  $('navApp')?.addEventListener('click', () => showStep('app'));
  $('navPublish')?.addEventListener('click', () => showStep('publish'));
}

wire();
refreshAll().catch(() => toast('Failed to load onboarding status', 'bad'));
