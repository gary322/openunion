import { copyToClipboard, formatAgo, toast, initHashViews, el } from '/ui/pw.js';

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

function setFoldOpen(id, open, opts = {}) {
  const el = $(id);
  if (!el) return;
  const force = Boolean(opts && opts.force);
  // Don't fight the user: once a fold has been manually toggled, guided mode should stop
  // auto-opening/closing it. This keeps the UI predictable and prevents async refreshes from
  // hiding controls mid-action.
  if (!force && String(el.dataset?.userToggled ?? '') === '1') return;
  try {
    el.open = Boolean(open);
  } catch {
    // ignore
  }
}

function setPill(id, text, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = String(text ?? '');
  el.classList.remove('good', 'warn', 'faint');
  if (kind) el.classList.add(kind);
}

function setText(id, text) {
  const el = $(id);
  if (!el) return;
  el.textContent = String(text ?? '');
}

function setTab(rootId, tabId) {
  const root = $(rootId);
  if (!root) return;
  const tabs = Array.from(root.querySelectorAll('[role="tab"]'));
  for (const tab of tabs) {
    const controls = tab.getAttribute('aria-controls');
    const on = String(tab.id) === String(tabId);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.classList.toggle('active', on);
    if (controls) {
      const panel = $(controls);
      if (panel) panel.hidden = !on;
    }
  }
}

let onboardingReqNo = 0;
async function refreshOnboardingStatus() {
  const reqNo = ++onboardingReqNo;

  const token = $('buyerToken')?.value?.trim?.() || getBuyerToken();
  const hasToken = Boolean(token);

  setStepDone('stepToken', hasToken);
  setPill('pillAccess', hasToken ? 'Connected' : 'Not connected', hasToken ? 'good' : 'warn');
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

    setPill('pillOrigins', 'No verified origins', 'warn');
    setPill('pillApps', 'No apps', 'warn');
    setPill('pillWork', 'No published bounties', 'warn');
    setPill('pillMoney', 'No payouts yet', 'faint');
    setPill('pillDisputes', '0 open', 'faint');

    // Guided mode: open only the next fold.
    setFoldOpen('foldAccess', true);
    setFoldOpen('foldOrigins', false);
    setFoldOpen('foldCors', false);
    setFoldOpen('foldApps', false);
    setFoldOpen('foldWork', false);
    setFoldOpen('foldMoney', false);
    setFoldOpen('foldDisputes', false);
    setFoldOpen('foldSettings', false);
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

  setPill('pillOrigins', verifiedOrigins > 0 ? `${verifiedOrigins} verified` : 'No verified origins', verifiedOrigins > 0 ? 'good' : 'warn');
  setPill('pillApps', appsCount > 0 ? `${appsCount} apps` : 'No apps', appsCount > 0 ? 'good' : 'warn');
  setPill('pillWork', publishedBounties > 0 ? `${publishedBounties} published` : 'No published bounties', publishedBounties > 0 ? 'good' : 'warn');
  setPill('pillMoney', paidCount > 0 ? `${paidCount} paid` : 'No payouts yet', paidCount > 0 ? 'good' : 'faint');
  setPill('pillDisputes', `${openDisputes} open`, openDisputes > 0 ? 'warn' : 'faint');

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

  // Workflow-first "next action" (reduce "what do I do?" moments).
  const nextLabel = $('onboardingNextLabel');
  const nextBtn = $('btnOnboardingNext');
  if (nextLabel && nextBtn) {
    let href = '#integrations';
    let label = 'Connect your platform';
    let foldId = 'foldAccess';
    if (!hasToken) {
      href = '#integrations';
      label = 'Connect your platform';
      foldId = 'foldAccess';
    } else if (verifiedOrigins <= 0) {
      href = '#integrations';
      label = 'Verify your domain';
      foldId = 'foldOrigins';
    } else if (!feeOk) {
      href = '#settings';
      label = 'Set your platform fee';
      foldId = 'foldSettings';
    } else if (appsCount <= 0) {
      href = '#apps';
      label = 'Create your first app';
      foldId = 'foldApps';
    } else if (publishedBounties <= 0) {
      href = '/apps/';
      label = 'Publish work via an app';
      foldId = 'foldWork';
    } else {
      href = '#money';
      label = 'View earnings';
      foldId = 'foldMoney';
    }
    nextLabel.textContent = label;
    nextBtn.setAttribute('href', href);
    nextBtn.dataset.nextFold = foldId;

    // Mirror the same "next action" as a persistent bottom actionbar to reduce scrolling/effort.
    const abTitle = $('buyerActionbarTitle');
    const abSub = $('buyerActionbarSub');
    const abBtn = $('btnBuyerActionbar');
    if (abTitle) abTitle.textContent = `Next: ${label}`;
    if (abSub) {
      abSub.textContent =
        href.startsWith('/apps/')
          ? 'Open the catalog, pick an app, and publish work in seconds.'
          : 'The console will guide you step-by-step. Dev mode reveals raw JSON and IDs.';
    }
    if (abBtn) {
      abBtn.dataset.href = href;
      abBtn.dataset.nextFold = foldId;
      abBtn.textContent = href.startsWith('/apps/') ? 'Open apps' : 'Continue';
    }
  }

  // Guided mode: open only the next fold (and keep Disputes open if urgent).
  const nextFold = nextBtn?.dataset?.nextFold || '';
  setFoldOpen('foldAccess', nextFold === 'foldAccess');
  setFoldOpen('foldOrigins', nextFold === 'foldOrigins');
  setFoldOpen('foldCors', false);
  setFoldOpen('foldApps', nextFold === 'foldApps');
  setFoldOpen('foldWork', nextFold === 'foldWork');
  setFoldOpen('foldMoney', nextFold === 'foldMoney');
  setFoldOpen('foldDisputes', openDisputes > 0);
  setFoldOpen('foldSettings', nextFold === 'foldSettings');
}

function initAccessTabs() {
  const root = $('accessTabs');
  if (!root) return;

  const LS_TAB = 'pw_buyer_access_tab';
  const saved = String(localStorage.getItem(LS_TAB) || '').trim();
  const fallback = 'tabAccessLogin';
  const initial = saved && $(saved) ? saved : fallback;
  setTab('accessTabs', initial);

  root.addEventListener('click', (ev) => {
    const btn = ev.target?.closest?.('[role="tab"]');
    if (!btn) return;
    const id = String(btn.id || '').trim();
    if (!id) return;
    localStorage.setItem(LS_TAB, id);
    setTab('accessTabs', id);
  });
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

function renderAppPreview(uiSchema) {
  const root = $('appPreviewBody');
  if (!root) return;
  clearNode(root);

  const sections = Array.isArray(uiSchema?.sections) ? uiSchema.sections : [];
  if (!sections.length) {
    const empty = document.createElement('div');
    empty.className = 'pw-muted';
    empty.textContent = 'No friendly form configured. Pick a template or enable Dev mode to edit JSON.';
    root.appendChild(empty);
    return;
  }

  for (const sec of sections) {
    const wrap = document.createElement('div');
    wrap.className = 'pw-card soft';

    const title = document.createElement('div');
    title.className = 'pw-kicker';
    title.textContent = String(sec?.title ?? 'Section');
    wrap.appendChild(title);

    const fields = Array.isArray(sec?.fields) ? sec.fields : [];
    const list = document.createElement('div');
    list.className = 'pw-stack-sm';
    for (const f of fields.slice(0, 12)) {
      const row = document.createElement('div');
      row.className = 'pw-row';
      const left = document.createElement('div');
      left.className = 'pw-muted';
      left.textContent = String(f?.label ?? f?.key ?? 'Field');
      row.appendChild(left);
      if (f?.required) {
        const req = document.createElement('span');
        req.className = 'pw-chip warn';
        req.textContent = 'required';
        row.appendChild(req);
      }
      list.appendChild(row);
    }
    if (fields.length > 12) {
      const more = document.createElement('div');
      more.className = 'pw-muted';
      more.textContent = `+${fields.length - 12} more…`;
      list.appendChild(more);
    }
    wrap.appendChild(list);
    root.appendChild(wrap);
  }
}

const APP_DESIGNER_FIELD_TYPES = [
  ['text', 'Text'],
  ['textarea', 'Long text'],
  ['url', 'URL'],
  ['number', 'Number'],
  ['select', 'Select'],
  ['boolean', 'Yes/No'],
  ['date', 'Date'],
];
const APP_DESIGNER_STORES = [
  ['input_spec', 'Input'],
  ['site_profile', 'Site profile'],
];
const APP_DESIGNER_CAPS = [
  ['browser', 'Browser'],
  ['http', 'HTTP'],
  ['ffmpeg', 'FFmpeg'],
  ['llm_summarize', 'LLM summarize'],
  ['screenshot', 'Screenshot'],
];
const APP_DESIGNER_ARTIFACT_KINDS = [
  ['log', 'Log'],
  ['screenshot', 'Screenshot'],
  ['snapshot', 'Snapshot'],
  ['pdf', 'PDF'],
  ['video', 'Video'],
  ['other', 'Other'],
];

let appDesignerWired = false;
let appDesignerSyncTimer = 0;

function optionsTextFromArray(options) {
  const opts = Array.isArray(options) ? options : [];
  const lines = [];
  for (const o of opts) {
    const label = String(o?.label ?? '').trim();
    const value = String(o?.value ?? '').trim();
    if (!label && !value) continue;
    if (!label || label === value) lines.push(value || label);
    else lines.push(`${label}: ${value}`);
  }
  return lines.join('\n');
}

function parseOptionsText(text) {
  const raw = String(text ?? '');
  const out = [];
  for (const line of raw.split('\n')) {
    const s = String(line).trim();
    if (!s) continue;
    const idx = s.indexOf(':');
    if (idx === -1) {
      out.push({ label: s, value: s });
      continue;
    }
    const label = s.slice(0, idx).trim();
    const value = s.slice(idx + 1).trim();
    if (!label && !value) continue;
    out.push({ label: label || value, value: value || label });
  }
  return out;
}

function ensureAppDesignerScaffolding() {
  if (!generatedAppUiSchema || typeof generatedAppUiSchema !== 'object') return;
  if (!generatedAppDefaultDescriptor || typeof generatedAppDefaultDescriptor !== 'object') return;

  if (!Array.isArray(generatedAppUiSchema.sections) || !generatedAppUiSchema.sections.length) {
    generatedAppUiSchema.sections = [
      {
        id: 'request',
        title: 'Request',
        description: '',
        fields: [],
      },
    ];
  }
  const sec = generatedAppUiSchema.sections[0];
  if (!sec.id) sec.id = 'request';
  if (!sec.title) sec.title = 'Request';
  if (!Array.isArray(sec.fields)) sec.fields = [];

  if (!Array.isArray(generatedAppDefaultDescriptor.capability_tags) || generatedAppDefaultDescriptor.capability_tags.length < 1) {
    generatedAppDefaultDescriptor.capability_tags = ['http'];
  }
  if (!generatedAppDefaultDescriptor.input_spec || typeof generatedAppDefaultDescriptor.input_spec !== 'object') {
    generatedAppDefaultDescriptor.input_spec = {};
  }
  if (!generatedAppDefaultDescriptor.output_spec || typeof generatedAppDefaultDescriptor.output_spec !== 'object') {
    generatedAppDefaultDescriptor.output_spec = {};
  }
}

function syncGeneratedToDevJson() {
  const dd = $('appDefaultDescriptor');
  const us = $('appUiSchema');
  if (dd && generatedAppDefaultDescriptor) dd.value = pretty(generatedAppDefaultDescriptor);
  if (us && generatedAppUiSchema) us.value = pretty(generatedAppUiSchema);
  renderAppPreview(generatedAppUiSchema);
}

function scheduleAppDesignerSync() {
  if (appDesignerSyncTimer) clearTimeout(appDesignerSyncTimer);
  appDesignerSyncTimer = setTimeout(() => {
    appDesignerSyncTimer = 0;
    syncAppDesignerFromDom();
  }, 160);
}

function flushAppDesignerSync() {
  if (appDesignerSyncTimer) {
    clearTimeout(appDesignerSyncTimer);
    appDesignerSyncTimer = 0;
  }
  syncAppDesignerFromDom();
}

function syncAppDesignerFromDom() {
  if (!generatedAppUiSchema || !generatedAppDefaultDescriptor) return;
  ensureAppDesignerScaffolding();

  const sec = generatedAppUiSchema.sections[0];
  const prevFields = Array.isArray(sec.fields) ? sec.fields : [];

  const category = $('appCategory')?.value?.trim?.() || '';
  if (category) generatedAppUiSchema.category = category;
  else delete generatedAppUiSchema.category;

  const title = $('appSectionTitle')?.value?.trim?.() || '';
  sec.title = title || 'Request';

  const payoutRaw = $('appDefaultPayoutCents')?.value;
  const proofsRaw = $('appDefaultRequiredProofs')?.value;
  const payoutCents = payoutRaw === undefined || payoutRaw === null || String(payoutRaw).trim() === '' ? null : Math.max(0, Math.floor(Number(payoutRaw)));
  const requiredProofs = proofsRaw === undefined || proofsRaw === null || String(proofsRaw).trim() === '' ? null : Math.max(0, Math.floor(Number(proofsRaw)));
  if (payoutCents !== null || requiredProofs !== null) {
    generatedAppUiSchema.bounty_defaults = generatedAppUiSchema.bounty_defaults && typeof generatedAppUiSchema.bounty_defaults === 'object' ? generatedAppUiSchema.bounty_defaults : {};
    if (payoutCents !== null) generatedAppUiSchema.bounty_defaults.payout_cents = payoutCents;
    else delete generatedAppUiSchema.bounty_defaults.payout_cents;
    if (requiredProofs !== null) generatedAppUiSchema.bounty_defaults.required_proofs = requiredProofs;
    else delete generatedAppUiSchema.bounty_defaults.required_proofs;
  } else {
    delete generatedAppUiSchema.bounty_defaults;
  }

  const freshnessRaw = $('appFreshnessSla')?.value;
  const freshness = freshnessRaw === undefined || freshnessRaw === null || String(freshnessRaw).trim() === '' ? null : Math.max(1, Math.floor(Number(freshnessRaw)));
  if (freshness) generatedAppDefaultDescriptor.freshness_sla_sec = freshness;
  else delete generatedAppDefaultDescriptor.freshness_sla_sec;

  const fieldsRoot = $('appFieldsList');
  const tbody = $('appFieldsTbody'); // dev-only table editor
  const rows = fieldsRoot
    ? Array.from(fieldsRoot.querySelectorAll('[data-field-card="1"]'))
    : tbody
      ? Array.from(tbody.querySelectorAll('tr[data-field-row="1"]'))
      : [];
  const nextFields = [];
  const usedKeys = new Set();
  for (let i = 0; i < rows.length; i++) {
    const tr = rows[i];
    const keyIn = tr.querySelector('[data-col="key"]');
    const labelIn = tr.querySelector('[data-col="label"]');
    const typeSel = tr.querySelector('[data-col="type"]');
    const storeSel = tr.querySelector('[data-col="store"]');
    const reqIn = tr.querySelector('[data-col="required"]');
    const phIn = tr.querySelector('[data-col="placeholder"]');
    const defIn = tr.querySelector('[data-col="default"]');
    const optIn = tr.querySelector('[data-col="options"]');
    const targetIn = tr.querySelector('[data-col="target"]');

    const labelRaw = String(labelIn?.value ?? '').trim();
    let key = String(keyIn?.value ?? '').trim();
    if (!key) key = toSnake(labelRaw);
    // If the user added a placeholder "field_1" row, rename it based on the label.
    if (labelRaw && /^field(_\\d+)?$/.test(key)) {
      const derived = toSnake(labelRaw);
      if (derived) key = derived;
    }
    if (!key) continue;
    let uniq = key;
    let n = 1;
    while (usedKeys.has(uniq)) {
      n += 1;
      uniq = `${key}_${n}`;
    }
    key = uniq;
    usedKeys.add(key);
    // Keep the hidden/dev key input consistent when the builder auto-generates.
    if (keyIn && String(keyIn.value || '').trim() !== key) keyIn.value = key;

    const label = labelRaw || key;
    const type = String(typeSel?.value ?? 'text').trim() || 'text';
    const store = String(storeSel?.value ?? 'input_spec').trim() === 'site_profile' ? 'site_profile' : 'input_spec';
    const required = Boolean(reqIn?.checked);
    const placeholder = String(phIn?.value ?? '').trim();
    const defaultRaw = String(defIn?.value ?? '').trim();
    const optionsText = String(optIn?.value ?? '');

    const prev = prevFields[i] && typeof prevFields[i] === 'object' ? prevFields[i] : {};
    const prevTarget = String(prev?.target ?? '').trim();
    const prevKey = String(prev?.key ?? '').trim();
    const prevStore = prevTarget.startsWith('site_profile.') ? 'site_profile' : 'input_spec';

    let target = prevTarget;
    const typedTarget = String(targetIn?.value ?? '').trim();
    if (typedTarget) target = typedTarget;
    if (!target || prevKey !== key || prevStore !== store) target = `${store}.${key}`;
    if (targetIn && !String(targetIn.value || '').trim()) targetIn.value = target;

    const next = { ...prev };
    next.key = key;
    next.label = label;
    next.type = type;
    next.required = required ? true : undefined;
    if (placeholder) next.placeholder = placeholder;
    else delete next.placeholder;
    next.target = target;

    if (defaultRaw) {
      if (type === 'number') {
        const n = Number(defaultRaw);
        if (Number.isFinite(n)) next.default = n;
        else delete next.default;
      } else if (type === 'boolean') {
        // default is stored as a boolean; the input uses "true/false" text in non-dev modes.
        const s = defaultRaw.toLowerCase();
        if (s === 'true' || s === '1' || s === 'yes') next.default = true;
        else if (s === 'false' || s === '0' || s === 'no') next.default = false;
        else delete next.default;
      } else {
        next.default = defaultRaw;
      }
    } else {
      delete next.default;
    }

    if (type === 'select') {
      const opts = parseOptionsText(optionsText);
      if (opts.length) next.options = opts;
      else delete next.options;
    } else {
      delete next.options;
    }

    if (type !== 'textarea') delete next.format;
    if (type !== 'number') {
      delete next.min;
      delete next.max;
    }

    nextFields.push(next);
  }

  if (!nextFields.length) {
    nextFields.push({
      key: 'instructions',
      label: 'Instructions',
      type: 'textarea',
      placeholder: 'Describe the task in a few sentences.',
      target: 'input_spec.instructions',
    });
  }
  sec.fields = nextFields;

  const outRoot = $('appOutputsList');
  const outTbody = $('appOutputsTbody'); // dev-only table editor
  const outRows = outRoot
    ? Array.from(outRoot.querySelectorAll('[data-output-card="1"]'))
    : outTbody
      ? Array.from(outTbody.querySelectorAll('tr[data-output-row="1"]'))
      : [];
  const reqArtifacts = [];
  for (const tr of outRows) {
    const kindSel = tr.querySelector('[data-col="kind"]');
    const labelIn = tr.querySelector('[data-col="label"]');
    const countIn = tr.querySelector('[data-col="count"]');
    const kind = String(kindSel?.value ?? 'log').trim() || 'log';
    const label = String(labelIn?.value ?? '').trim();
    const countRaw = String(countIn?.value ?? '').trim();
    const count = countRaw ? Math.max(1, Math.floor(Number(countRaw))) : undefined;
    const row = { kind };
    if (label) row.label = label;
    else row.label = kind;
    if (count !== undefined) row.count = count;
    reqArtifacts.push(row);
  }
  if (reqArtifacts.length) {
    if (!generatedAppDefaultDescriptor.output_spec || typeof generatedAppDefaultDescriptor.output_spec !== 'object') generatedAppDefaultDescriptor.output_spec = {};
    generatedAppDefaultDescriptor.output_spec.required_artifacts = reqArtifacts;
  } else if (generatedAppDefaultDescriptor.output_spec && typeof generatedAppDefaultDescriptor.output_spec === 'object') {
    delete generatedAppDefaultDescriptor.output_spec.required_artifacts;
  }

  syncGeneratedToDevJson();
}

function renderAppDesigner() {
  const card = $('appDesignerCard');
  const fieldsList = $('appFieldsList');
  const outputsList = $('appOutputsList');
  const tbody = $('appFieldsTbody'); // dev-only table editor
  const outTbody = $('appOutputsTbody'); // dev-only table editor
  const capsWrap = $('appCapsWrap');
  if (!card || !fieldsList || !outputsList || !capsWrap) return;

  if (!appDesignerWired) {
    appDesignerWired = true;

    $('appCategory')?.addEventListener?.('input', scheduleAppDesignerSync);
    $('appSectionTitle')?.addEventListener?.('input', scheduleAppDesignerSync);
    $('appFreshnessSla')?.addEventListener?.('input', scheduleAppDesignerSync);
    $('appDefaultPayoutCents')?.addEventListener?.('input', scheduleAppDesignerSync);
    $('appDefaultRequiredProofs')?.addEventListener?.('input', scheduleAppDesignerSync);

    $('btnAppAddField')?.addEventListener?.('click', () => {
      if (!generatedAppUiSchema) return toast('Name your app first', 'bad');
      flushAppDesignerSync();
      ensureAppDesignerScaffolding();
      const sec = generatedAppUiSchema.sections[0];
      const existing = new Set((sec.fields || []).map((f) => String(f?.key || '').trim()).filter(Boolean));
      let base = 'field';
      let n = 1;
      let key = base;
      while (existing.has(key)) {
        n += 1;
        key = `${base}_${n}`;
      }
      sec.fields.push({ key, label: 'Field', type: 'text', target: `input_spec.${key}` });
      renderAppDesigner();
      syncGeneratedToDevJson();
    });

    $('btnAppAddOutput')?.addEventListener?.('click', () => {
      if (!generatedAppDefaultDescriptor) return toast('Name your app first', 'bad');
      flushAppDesignerSync();
      ensureAppDesignerScaffolding();
      if (!generatedAppDefaultDescriptor.output_spec || typeof generatedAppDefaultDescriptor.output_spec !== 'object') generatedAppDefaultDescriptor.output_spec = {};
      const cur = Array.isArray(generatedAppDefaultDescriptor.output_spec.required_artifacts)
        ? generatedAppDefaultDescriptor.output_spec.required_artifacts
        : [];
      cur.push({ kind: 'log', label: 'report' });
      generatedAppDefaultDescriptor.output_spec.required_artifacts = cur;
      renderAppDesigner();
      syncGeneratedToDevJson();
    });

    // Card builder event delegation (primary UX).
    fieldsList.addEventListener('input', (ev) => {
      const t = ev.target;
      if (!t) return;
      if (t.matches('[data-col="label"],[data-col="placeholder"],[data-col="options"],[data-col="required"],[data-col="default"],[data-col="key"],[data-col="target"]')) {
        scheduleAppDesignerSync();
      }
    });
    fieldsList.addEventListener('change', (ev) => {
      const t = ev.target;
      if (!t) return;
      if (t.matches('[data-col="type"]')) {
        const card = t.closest('[data-field-card="1"]');
        const opt = card?.querySelector?.('[data-col="options"]');
        if (opt) opt.disabled = String(t.value) !== 'select';
        scheduleAppDesignerSync();
      }
      if (t.matches('[data-col="store"]')) {
        const card = t.closest('[data-field-card="1"]');
        const keyIn = card?.querySelector?.('[data-col="key"]');
        const targetIn = card?.querySelector?.('[data-col="target"]');
        const key = String(keyIn?.value ?? '').trim();
        const store = String(t.value ?? 'input_spec').trim() === 'site_profile' ? 'site_profile' : 'input_spec';
        if (key && targetIn) {
          const curTarget = String(targetIn.value || '').trim();
          const isAuto = !curTarget || curTarget.endsWith(`.${key}`);
          if (isAuto) targetIn.value = `${store}.${key}`;
        }
        scheduleAppDesignerSync();
      }
    });
    fieldsList.addEventListener(
      'blur',
      (ev) => {
        const t = ev.target;
        if (!t) return;
        // Auto-generate a stable key when the user edits the label (unless they already typed a key in Dev mode).
        if (t.matches('[data-col="label"]')) {
          const card = t.closest('[data-field-card="1"]');
          const keyIn = card?.querySelector?.('[data-col="key"]');
          const storeSel = card?.querySelector?.('[data-col="store"]');
          const targetIn = card?.querySelector?.('[data-col="target"]');
          const keyCur = String(keyIn?.value ?? '').trim();
          const derived = toSnake(String(t.value || ''));
          if (derived && (!keyCur || /^field(_\\d+)?$/.test(keyCur))) {
            if (keyIn) keyIn.value = derived;
          }
          const store = String(storeSel?.value ?? 'input_spec').trim() === 'site_profile' ? 'site_profile' : 'input_spec';
          const finalKey = String(keyIn?.value ?? '').trim();
          if (finalKey && targetIn) {
            const curTarget = String(targetIn.value || '').trim();
            const prevAuto = keyCur ? `${store}.${keyCur}` : '';
            if (!curTarget || (prevAuto && curTarget === prevAuto)) targetIn.value = `${store}.${finalKey}`;
          }
          scheduleAppDesignerSync();
        }
        if (t.matches('[data-col="key"]')) {
          const next = toSnake(String(t.value || ''));
          if (next && next !== String(t.value || '')) t.value = next;
          scheduleAppDesignerSync();
        }
      },
      true
    );
    fieldsList.addEventListener('click', (ev) => {
      const btn = ev.target?.closest?.('button[data-action="remove-field"]');
      if (!btn) return;
      if (!generatedAppUiSchema) return;
      flushAppDesignerSync();
      ensureAppDesignerScaffolding();
      const idx = Number(btn.dataset.idx || '0');
      const sec = generatedAppUiSchema.sections[0];
      if (!Array.isArray(sec.fields)) sec.fields = [];
      sec.fields.splice(idx, 1);
      if (!sec.fields.length) {
        sec.fields.push({
          key: 'instructions',
          label: 'Instructions',
          type: 'textarea',
          placeholder: 'Describe the task in a few sentences.',
          target: 'input_spec.instructions',
        });
      }
      renderAppDesigner();
      syncGeneratedToDevJson();
    });

    // Outputs card builder
    outputsList.addEventListener('input', (ev) => {
      const t = ev.target;
      if (!t) return;
      if (t.matches('[data-col="label"],[data-col="count"]')) scheduleAppDesignerSync();
    });
    outputsList.addEventListener('change', (ev) => {
      const t = ev.target;
      if (!t) return;
      if (t.matches('[data-col="kind"]')) scheduleAppDesignerSync();
    });
    outputsList.addEventListener('click', (ev) => {
      const btn = ev.target?.closest?.('button[data-action="remove-output"]');
      if (!btn) return;
      if (!generatedAppDefaultDescriptor) return;
      flushAppDesignerSync();
      ensureAppDesignerScaffolding();
      if (!generatedAppDefaultDescriptor.output_spec || typeof generatedAppDefaultDescriptor.output_spec !== 'object') generatedAppDefaultDescriptor.output_spec = {};
      const cur = Array.isArray(generatedAppDefaultDescriptor.output_spec.required_artifacts)
        ? generatedAppDefaultDescriptor.output_spec.required_artifacts
        : [];
      const idx = Number(btn.dataset.idx || '0');
      cur.splice(idx, 1);
      generatedAppDefaultDescriptor.output_spec.required_artifacts = cur;
      renderAppDesigner();
      syncGeneratedToDevJson();
    });

    // Capabilities chip toggles
    capsWrap.addEventListener('click', (ev) => {
      const btn = ev.target?.closest?.('button[data-cap]');
      if (!btn) return;
      if (!generatedAppDefaultDescriptor) return;
      flushAppDesignerSync();
      ensureAppDesignerScaffolding();
      const cap = String(btn.dataset.cap || '').trim();
      if (!cap) return;
      const cur = new Set(Array.isArray(generatedAppDefaultDescriptor.capability_tags) ? generatedAppDefaultDescriptor.capability_tags : []);
      if (cur.has(cap)) {
        if (cur.size <= 1) return toast('At least one capability tag is required', 'bad');
        cur.delete(cap);
      } else {
        cur.add(cap);
      }
      generatedAppDefaultDescriptor.capability_tags = Array.from(cur);
      renderAppDesigner();
      syncGeneratedToDevJson();
    });
  }

  // No app named yet: keep it calm and non-interactive.
  if (!generatedAppUiSchema || !generatedAppDefaultDescriptor) {
    fieldsList.replaceChildren(
      (() => {
        const empty = document.createElement('div');
        empty.className = 'pw-builder-card';
        empty.textContent = 'Name your app and pick a template to start designing.';
        return empty;
      })()
    );
    outputsList.replaceChildren(
      (() => {
        const empty = document.createElement('div');
        empty.className = 'pw-builder-card';
        empty.textContent = 'Optional: set required outputs to guide worker uploads.';
        return empty;
      })()
    );
    if (tbody) tbody.innerHTML = '<tr><td class="pw-muted" colspan="8">Name your app and pick a template to start designing.</td></tr>';
    if (outTbody) outTbody.innerHTML = '<tr><td class="pw-muted" colspan="4">Optional: set required outputs after you add fields.</td></tr>';
    capsWrap.replaceChildren();
    return;
  }

  ensureAppDesignerScaffolding();

  const sec = generatedAppUiSchema.sections[0];
  $('appCategory').value = String(generatedAppUiSchema.category || '');
  $('appSectionTitle').value = String(sec.title || 'Request');

  const freshness = generatedAppDefaultDescriptor.freshness_sla_sec;
  $('appFreshnessSla').value = freshness ? String(freshness) : '';

  const payoutCents = generatedAppUiSchema?.bounty_defaults?.payout_cents;
  const requiredProofs = generatedAppUiSchema?.bounty_defaults?.required_proofs;
  $('appDefaultPayoutCents').value = payoutCents === undefined || payoutCents === null ? '' : String(payoutCents);
  $('appDefaultRequiredProofs').value = requiredProofs === undefined || requiredProofs === null ? '' : String(requiredProofs);

  // Caps
  const caps = new Set(Array.isArray(generatedAppDefaultDescriptor.capability_tags) ? generatedAppDefaultDescriptor.capability_tags : []);
  capsWrap.replaceChildren(
    ...APP_DESIGNER_CAPS.map(([id, label]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pw-chip pw-chip-btn';
      btn.dataset.cap = id;
      btn.setAttribute('aria-pressed', caps.has(id) ? 'true' : 'false');
      btn.title = 'Toggle capability tag';
      btn.textContent = label;
      return btn;
    })
  );

  function renderFieldCard(f, idx) {
    const wrap = document.createElement('div');
    wrap.className = 'pw-builder-card';
    wrap.dataset.fieldCard = '1';

    const titleText = String(f?.label || f?.key || `Field ${idx + 1}`);
    const head = document.createElement('div');
    head.className = 'pw-builder-head';
    head.appendChild(
      (() => {
        const left = document.createElement('div');
        left.className = 'pw-builder-title';
        const pill = document.createElement('span');
        pill.className = 'pw-pill faint';
        pill.textContent = `Field ${idx + 1}`;
        const strong = document.createElement('strong');
        strong.textContent = titleText;
        left.appendChild(pill);
        left.appendChild(strong);
        return left;
      })()
    );

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'pw-icon-btn danger';
    rm.textContent = 'Remove';
    rm.dataset.action = 'remove-field';
    rm.dataset.idx = String(idx);
    rm.setAttribute('aria-label', `Remove field ${idx + 1}`);
    head.appendChild(rm);
    wrap.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'pw-grid';

    const label = document.createElement('div');
    label.className = 'pw-field';
    label.appendChild(el('label', { text: 'Question' }));
    const inLabel = document.createElement('input');
    inLabel.className = 'pw-input';
    inLabel.placeholder = 'e.g. Target URL';
    inLabel.value = String(f?.label || '');
    inLabel.setAttribute('data-col', 'label');
    label.appendChild(inLabel);

    const type = document.createElement('div');
    type.className = 'pw-field';
    type.appendChild(el('label', { text: 'Type' }));
    const selType = document.createElement('select');
    selType.className = 'pw-select';
    selType.setAttribute('data-col', 'type');
    for (const [id, lab] of APP_DESIGNER_FIELD_TYPES) selType.appendChild(el('option', { value: id }, [lab]));
    selType.value = String(f?.type || 'text');
    type.appendChild(selType);

    const store = document.createElement('div');
    store.className = 'pw-field';
    store.appendChild(el('label', { text: 'Store' }));
    const selStore = document.createElement('select');
    selStore.className = 'pw-select';
    selStore.setAttribute('data-col', 'store');
    for (const [id, lab] of APP_DESIGNER_STORES) selStore.appendChild(el('option', { value: id }, [lab]));
    const target = String(f?.target || '').trim();
    selStore.value = target.startsWith('site_profile.') ? 'site_profile' : 'input_spec';
    store.appendChild(selStore);

    const req = document.createElement('div');
    req.className = 'pw-field';
    req.appendChild(el('label', { text: 'Required' }));
    const reqLab = document.createElement('label');
    reqLab.className = 'pw-check';
    const inReq = document.createElement('input');
    inReq.type = 'checkbox';
    inReq.checked = Boolean(f?.required);
    inReq.setAttribute('data-col', 'required');
    reqLab.appendChild(inReq);
    reqLab.appendChild(el('span', { text: 'Required' }));
    req.appendChild(reqLab);

    const ph = document.createElement('div');
    ph.className = 'pw-field';
    ph.appendChild(el('label', { text: 'Placeholder (optional)' }));
    const inPh = document.createElement('input');
    inPh.className = 'pw-input';
    inPh.placeholder = 'Shown as an example input';
    inPh.value = String(f?.placeholder || '');
    inPh.setAttribute('data-col', 'placeholder');
    ph.appendChild(inPh);

    const def = document.createElement('div');
    def.className = 'pw-field';
    def.appendChild(el('label', { text: 'Default (optional)' }));
    const inDef = document.createElement('input');
    inDef.className = 'pw-input';
    inDef.placeholder = 'Auto-filled for job creators';
    inDef.value = f?.default === undefined || f?.default === null ? '' : String(f.default);
    inDef.setAttribute('data-col', 'default');
    def.appendChild(inDef);

    const devKey = document.createElement('div');
    devKey.className = 'pw-field pw-dev';
    devKey.appendChild(el('label', { text: 'Key (dev)' }));
    const inKey = document.createElement('input');
    inKey.className = 'pw-input';
    inKey.placeholder = 'target_url';
    inKey.value = String(f?.key || '');
    inKey.setAttribute('data-col', 'key');
    devKey.appendChild(inKey);

    const devTarget = document.createElement('div');
    devTarget.className = 'pw-field pw-dev';
    devTarget.appendChild(el('label', { text: 'Target (dev)' }));
    const inTarget = document.createElement('input');
    inTarget.className = 'pw-input';
    inTarget.placeholder = 'input_spec.target_url';
    inTarget.value = String(f?.target || '');
    inTarget.setAttribute('data-col', 'target');
    devTarget.appendChild(inTarget);

    const optWrap = document.createElement('div');
    optWrap.className = 'pw-field pw-span-all';
    optWrap.appendChild(el('label', { text: 'Options (select only)' }));
    const inOpt = document.createElement('textarea');
    inOpt.className = 'pw-textarea';
    inOpt.rows = 2;
    inOpt.placeholder = 'one per line (e.g. small: S)';
    inOpt.value = optionsTextFromArray(f?.options);
    inOpt.setAttribute('data-col', 'options');
    inOpt.disabled = String(selType.value) !== 'select';
    optWrap.appendChild(inOpt);
    optWrap.appendChild(el('div', { class: 'pw-help', text: 'Use “label: value” or just “value”.' }));

    grid.appendChild(label);
    grid.appendChild(type);
    grid.appendChild(store);
    grid.appendChild(req);
    grid.appendChild(ph);
    grid.appendChild(def);
    grid.appendChild(devKey);
    grid.appendChild(devTarget);
    grid.appendChild(optWrap);

    wrap.appendChild(grid);
    return wrap;
  }

  const fields = Array.isArray(sec.fields) ? sec.fields : [];
  fieldsList.replaceChildren(...fields.map((f, i) => renderFieldCard(f, i)));

  // Outputs
  function renderOutputCard(a, idx) {
    const wrap = document.createElement('div');
    wrap.className = 'pw-builder-card';
    wrap.dataset.outputCard = '1';

    const head = document.createElement('div');
    head.className = 'pw-builder-head';
    head.appendChild(
      (() => {
        const left = document.createElement('div');
        left.className = 'pw-builder-title';
        const pill = document.createElement('span');
        pill.className = 'pw-pill faint';
        pill.textContent = `Output ${idx + 1}`;
        const strong = document.createElement('strong');
        strong.textContent = String(a?.label || a?.kind || `Output ${idx + 1}`);
        left.appendChild(pill);
        left.appendChild(strong);
        return left;
      })()
    );

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'pw-icon-btn danger';
    rm.textContent = 'Remove';
    rm.dataset.action = 'remove-output';
    rm.dataset.idx = String(idx);
    rm.setAttribute('aria-label', `Remove output ${idx + 1}`);
    head.appendChild(rm);
    wrap.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'pw-grid';

    const kind = document.createElement('div');
    kind.className = 'pw-field';
    kind.appendChild(el('label', { text: 'Kind' }));
    const selKind = document.createElement('select');
    selKind.className = 'pw-select';
    selKind.setAttribute('data-col', 'kind');
    for (const [id, lab] of APP_DESIGNER_ARTIFACT_KINDS) selKind.appendChild(el('option', { value: id }, [lab]));
    selKind.value = String(a?.kind || 'log');
    kind.appendChild(selKind);

    const lab = document.createElement('div');
    lab.className = 'pw-field';
    lab.appendChild(el('label', { text: 'Label' }));
    const inLab = document.createElement('input');
    inLab.className = 'pw-input';
    inLab.placeholder = 'e.g. report';
    inLab.value = String(a?.label || '');
    inLab.setAttribute('data-col', 'label');
    lab.appendChild(inLab);

    const count = document.createElement('div');
    count.className = 'pw-field';
    count.appendChild(el('label', { text: 'Count (optional)' }));
    const inCount = document.createElement('input');
    inCount.className = 'pw-input';
    inCount.type = 'number';
    inCount.min = '1';
    inCount.placeholder = '1';
    inCount.value = a?.count ? String(a.count) : '';
    inCount.setAttribute('data-col', 'count');
    count.appendChild(inCount);

    grid.appendChild(kind);
    grid.appendChild(lab);
    grid.appendChild(count);
    wrap.appendChild(grid);
    return wrap;
  }

  const reqArtifacts = Array.isArray(generatedAppDefaultDescriptor?.output_spec?.required_artifacts)
    ? generatedAppDefaultDescriptor.output_spec.required_artifacts
    : [];
  outputsList.replaceChildren(
    ...(reqArtifacts.length
      ? reqArtifacts.map((a, i) => renderOutputCard(a, i))
      : [
          (() => {
            const empty = document.createElement('div');
            empty.className = 'pw-builder-card';
            empty.textContent = 'Optional. Add at least one output to guide worker uploads.';
            return empty;
          })(),
        ])
  );

  // Dev-only tables are kept as a fallback/debug surface.
  if (tbody) tbody.innerHTML = '';
  if (outTbody) outTbody.innerHTML = '';
}

function appPageHrefFor(app) {
  const slug = String(app?.slug ?? '').trim();
  if (!slug) return '/apps/';
  return `/apps/app/${encodeURIComponent(slug)}/`;
}

function renderOrgAppsTable(apps) {
  const tbody = $('orgAppsTbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const rows = Array.isArray(apps) ? apps : [];
  for (const a of rows) {
    const tr = document.createElement('tr');
    const status = String(a?.status ?? 'active');
    const isDisabled = status === 'disabled';
    if (isDisabled) tr.classList.add('pw-row-muted');

    const tdName = document.createElement('td');
    tdName.textContent = String(a?.name ?? a?.slug ?? 'app');

    const tdTask = document.createElement('td');
    tdTask.className = 'pw-mono';
    tdTask.textContent = String(a?.taskType ?? '');

    const tdStatus = document.createElement('td');
    tdStatus.className = 'pw-mono';
    tdStatus.textContent = status;

    const tdPublic = document.createElement('td');
    tdPublic.className = 'pw-mono';
    tdPublic.textContent = a?.public ? 'yes' : 'no';

    const tdActions = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'pw-actions';

    const open = document.createElement('a');
    open.className = 'pw-btn';
    open.href = appPageHrefFor(a);
    open.textContent = 'Open';
    actions.appendChild(open);

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'pw-btn';
    copy.textContent = 'Copy task type';
    copy.addEventListener('click', () => copyToClipboard(String(a?.taskType ?? '')));
    actions.appendChild(copy);

    const disable = document.createElement('button');
    disable.type = 'button';
    disable.className = 'pw-btn danger';
    disable.textContent = isDisabled ? 'Disabled' : 'Disable';
    disable.disabled = isDisabled;
    disable.addEventListener('click', async () => {
      const token = $('buyerToken')?.value?.trim?.() || getBuyerToken();
      const csrf = getCsrfToken();
      const appId = String(a?.id ?? '').trim();
      if (!appId) return toast('Missing app id', 'bad');
      if (!confirm('Disable this app? New bounties/jobs for this task type will be blocked.')) return;

      setStatus('appsStatus', 'Disabling…');
      const { res } = await api(`/api/org/apps/${encodeURIComponent(appId)}`, {
        method: 'PATCH',
        token: token || undefined,
        csrf,
        body: { status: 'disabled' },
      });
      if (!res.ok) {
        setStatus('appsStatus', `disable failed (${res.status})`, 'bad');
        return;
      }
      toast('App disabled', 'good');
      onListOrgApps().catch(() => {});
    });
    actions.appendChild(disable);

    tdActions.appendChild(actions);

    tr.appendChild(tdName);
    tr.appendChild(tdTask);
    tr.appendChild(tdStatus);
    tr.appendChild(tdPublic);
    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  }

  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.className = 'pw-muted';
    td.textContent = 'No apps yet. Create one above.';
    tr.appendChild(td);
    tbody.appendChild(tr);
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

  if (templateId === 'custom') {
    const blank = { ...base };
    // Custom should feel like a blank canvas, not a hidden opinionated template.
    delete blank.freshness_sla_sec;
    return {
      defaultDescriptor: {
        ...blank,
        capability_tags: ['http'],
      },
      uiSchema: {
        schema_version: 'v1',
        bounty_defaults: { payout_cents: 1000, required_proofs: 1 },
        templates: [{ id: 'blank', name: 'Blank', preset: {} }],
        sections: [
          {
            id: 'request',
            title: 'Request',
            description: 'What should the worker do?',
            fields: [
              {
                key: 'instructions',
                label: 'Instructions',
                type: 'textarea',
                placeholder: 'Describe the task in a few sentences.',
                target: 'input_spec.instructions',
              },
            ],
          },
        ],
      },
    };
  }

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
        templates: [
          { id: 'default', name: 'Default scan', preset: { query: 'payments api', language: 'typescript', min_stars: 100 } },
        ],
        sections: [
          {
            id: 'search',
            title: 'Search',
            description: 'What to scan',
            fields: [
              { key: 'query', label: 'Query', type: 'text', required: true, placeholder: 'e.g. "vector db"', target: 'input_spec.query' },
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
              {
                key: 'constraints',
                label: 'Constraints (optional)',
                type: 'textarea',
                placeholder: 'Timeline, budget, domain focus, etc.',
                target: 'input_spec.constraints',
              },
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
              { key: 'keywords', label: 'Keywords (one per line)', type: 'textarea', format: 'lines', placeholder: 'sale\nin stock\nprice', target: 'input_spec.keywords' },
            ],
          },
        ],
      },
    };
  }

  // Default: generic HTTP + summarize.
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

let appLastAutoSlug = '';
let appLastAutoTaskType = '';
let appLastAutoDash = '';
let appLastTemplateId = '';
let generatedAppDefaultDescriptor = null;
let generatedAppUiSchema = null;

function autoFillAppIds() {
  const name = $('appName')?.value?.trim?.() || '';
  if (!name) return;
  const autoSlug = toKebab(name);
  const autoTaskType = toSnake(name);

  const slugEl = $('appSlug');
  const taskEl = $('appTaskType');
  const dashEl = $('appDashboardUrl');

  if (slugEl) {
    const cur = slugEl.value.trim();
    if (!cur || cur === appLastAutoSlug) slugEl.value = autoSlug;
  }
  if (taskEl) {
    const cur = taskEl.value.trim();
    if (!cur || cur === appLastAutoTaskType) taskEl.value = autoTaskType;
  }
  if (dashEl) {
    const cur = dashEl.value.trim();
    const next = autoSlug ? `/apps/app/${autoSlug}/` : '';
    if (!cur || cur === appLastAutoDash) dashEl.value = next;
    appLastAutoDash = next;
  }

  appLastAutoSlug = autoSlug;
  appLastAutoTaskType = autoTaskType;
}

function applySelectedAppTemplate() {
  const name = $('appName')?.value?.trim?.() || '';
  if (!name) {
    generatedAppDefaultDescriptor = null;
    generatedAppUiSchema = null;
    appLastTemplateId = '';
    renderAppPreview(null);
    renderAppDesigner();
    return;
  }

  const templateId = String($('appTemplate')?.value ?? 'custom');
  const templateChanged = templateId !== appLastTemplateId;
  autoFillAppIds();

  const taskType = $('appTaskType')?.value?.trim?.() || '';
  if (generatedAppDefaultDescriptor && generatedAppUiSchema && !templateChanged) {
    // Don't wipe the user's edits (designer or Dev JSON) just because they typed in the name
    // field again. Only update the task type.
    try {
      generatedAppDefaultDescriptor.type = taskType || generatedAppDefaultDescriptor.type;
    } catch {
      // ignore
    }
  } else {
    const built = buildAppTemplate(templateId, { taskType });
    generatedAppDefaultDescriptor = built.defaultDescriptor;
    generatedAppUiSchema = built.uiSchema;
    appLastTemplateId = templateId;
  }

  const dd = $('appDefaultDescriptor');
  const us = $('appUiSchema');
  if (dd) dd.value = pretty(generatedAppDefaultDescriptor);
  if (us) us.value = pretty(generatedAppUiSchema);
  renderAppPreview(generatedAppUiSchema);
  // Only re-render the form designer when the template changes; otherwise we'd clobber focus
  // while the user is typing in the table inputs.
  if (templateChanged) renderAppDesigner();
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
      const btnCheck = document.createElement('button');
      btnCheck.type = 'button';
      btnCheck.className = 'pw-btn primary';
      btnCheck.textContent = 'Check';
      btnCheck.addEventListener('click', () => {
        $('originId').value = String(o?.id ?? '');
        onCheckOrigin().catch((e) => setStatus('originStatus', String(e), 'bad'));
      });
      actions.appendChild(btnCheck);

      const btnCopy = document.createElement('button');
      btnCopy.type = 'button';
      btnCopy.className = 'pw-btn';
      btnCopy.textContent = 'Copy token';
      btnCopy.addEventListener('click', () => copyToClipboard(String(o?.token ?? '')));
      actions.appendChild(btnCopy);

      const btnRevoke = document.createElement('button');
      btnRevoke.type = 'button';
      btnRevoke.className = 'pw-btn danger';
      btnRevoke.textContent = 'Revoke';
      btnRevoke.addEventListener('click', () => {
        $('originId').value = String(o?.id ?? '');
        onRevokeOrigin().catch((e) => setStatus('originStatus', String(e), 'bad'));
      });
      actions.appendChild(btnRevoke);
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
  const requiredProofs = Number($('bProofs')?.value ?? 1);
  if (!Number.isFinite(requiredProofs) || requiredProofs < 1 || requiredProofs > 10) {
    return setStatus('bountyStatus', 'requiredProofs must be 1..10', 'bad');
  }
  const fingerprintClassesRequired = $('bFps')
    .value.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let disputeWindowSec = undefined;
  const disputeRaw = String($('bDisputeWindowSec')?.value ?? '').trim();
  if (disputeRaw) {
    const v = Number(disputeRaw);
    if (!Number.isFinite(v) || v < 0 || v > 60 * 60 * 24 * 30) {
      return setStatus('bountyStatus', 'disputeWindowSec must be 0..2592000', 'bad');
    }
    disputeWindowSec = Math.floor(v);
  }

  const { res, json } = await api('/api/bounties', {
    method: 'POST',
    token: token || undefined,
    csrf,
    body: { title, description, allowedOrigins, payoutCents, requiredProofs, disputeWindowSec, fingerprintClassesRequired },
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

async function onListOrgApps(opts = {}) {
  const silent = Boolean(opts && opts.silent);
  if (!silent) setStatus('appsStatus', '', null);
  const token = $('buyerToken').value.trim();
  const { res, json } = await api('/api/org/apps', { method: 'GET', token: token || undefined });
  $('appsOut').textContent = pretty(json);
  if (!res.ok) return setStatus('appsStatus', `list apps failed (${res.status})`, 'bad');
  renderOrgAppsTable(json.apps);
  if (!silent) setStatus('appsStatus', `ok (${json.apps?.length ?? 0} apps)`, 'good');
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
  } else if (generatedAppDefaultDescriptor) {
    defaultDescriptor = generatedAppDefaultDescriptor;
  }

  let uiSchema = undefined;
  const rawUi = ($('appUiSchema')?.value ?? '').trim();
  if (rawUi) {
    try {
      uiSchema = JSON.parse(rawUi);
    } catch {
      return setStatus('appsStatus', 'uiSchema JSON parse error', 'bad');
    }
  } else if (generatedAppUiSchema) {
    uiSchema = generatedAppUiSchema;
  }

  const { res, json } = await api('/api/org/apps', {
    method: 'POST',
    token: token || undefined,
    csrf,
    body: { slug, taskType, name, dashboardUrl, public: true, defaultDescriptor, uiSchema },
  });
  $('appsOut').textContent = pretty(json);
  if (!res.ok) return setStatus('appsStatus', `create app failed (${res.status})`, 'bad');
  setStatus('appsStatus', `created app ${json.app?.id || ''}`, 'good');
  onListOrgApps({ silent: true }).catch(() => {});
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

const btnOnboardingNext = $('btnOnboardingNext');
if (btnOnboardingNext) {
  btnOnboardingNext.addEventListener('click', (ev) => {
    const href = String(btnOnboardingNext.getAttribute('href') ?? '');
    // If the next action is a real navigation (e.g., /apps/), let it happen.
    if (href && !href.startsWith('#')) return;

    ev.preventDefault();
    const foldId = String(btnOnboardingNext.dataset?.nextFold ?? '').trim();
    if (foldId) setFoldOpen(foldId, true, { force: true });

    const targetId = href.replace(/^#/, '').trim();
    const target = targetId ? $(targetId) : null;
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
}

function goNextFromActionbar(btn) {
  const href = String(btn?.dataset?.href ?? '').trim();
  const foldId = String(btn?.dataset?.nextFold ?? '').trim();
  if (href && !href.startsWith('#')) {
    window.location.assign(href);
    return;
  }
  if (foldId) setFoldOpen(foldId, true, { force: true });
  const targetId = href.replace(/^#/, '').trim();
  const target = targetId ? $(targetId) : null;
  if (target && typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

const btnBuyerActionbar = $('btnBuyerActionbar');
if (btnBuyerActionbar) {
  btnBuyerActionbar.addEventListener('click', () => goNextFromActionbar(btnBuyerActionbar));
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

// App wizard: auto-generate ids and apply templates.
const appNameEl = $('appName');
if (appNameEl) {
  appNameEl.addEventListener('input', () => {
    autoFillAppIds();
    applySelectedAppTemplate();
  });
}
const appTemplateEl = $('appTemplate');
if (appTemplateEl) appTemplateEl.addEventListener('change', () => applySelectedAppTemplate());
const appTaskTypeEl = $('appTaskType');
if (appTaskTypeEl) appTaskTypeEl.addEventListener('input', () => applySelectedAppTemplate());

setBuyerToken(getBuyerToken());
setCsrfToken(getCsrfToken());
renderOriginGuide(null);

// Mark folds as "user-toggled" when a human clicks them so guided refreshes stop overriding.
for (const summary of Array.from(document.querySelectorAll('details.pw-fold > summary'))) {
  summary.addEventListener('click', (ev) => {
    const d = ev.currentTarget?.parentElement;
    if (d && d.tagName?.toLowerCase?.() === 'details') {
      try {
        d.dataset.userToggled = '1';
      } catch {
        // ignore
      }
    }
  });
}

initAccessTabs();
initHashViews({ defaultViewId: 'onboarding' });
refreshOnboardingStatus().catch(() => {});

autoFillAppIds();
applySelectedAppTemplate();

// Load "My apps" table when connected (token or session). Keep it best-effort so the page
// doesn't feel broken if the user hasn't connected yet.
if (getBuyerToken() || getCsrfToken()) {
  onListOrgApps({ silent: true }).catch(() => {});
}
