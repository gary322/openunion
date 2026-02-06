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
    renderAppPreview(null);
    return;
  }

  const templateId = String($('appTemplate')?.value ?? 'custom');
  autoFillAppIds();

  const taskType = $('appTaskType')?.value?.trim?.() || '';
  const built = buildAppTemplate(templateId, { taskType });
  generatedAppDefaultDescriptor = built.defaultDescriptor;
  generatedAppUiSchema = built.uiSchema;

  const dd = $('appDefaultDescriptor');
  const us = $('appUiSchema');
  if (dd) dd.value = pretty(generatedAppDefaultDescriptor);
  if (us) us.value = pretty(generatedAppUiSchema);
  renderAppPreview(generatedAppUiSchema);
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

refreshOnboardingStatus().catch(() => {});

autoFillAppIds();
applySelectedAppTemplate();
