import { copyToClipboard, el, fetchJson, formatAgo, storageGet, storageSet, toast, LS } from '/ui/pw.js';

function $(id) {
  return document.getElementById(id);
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

async function probeSession() {
  // Any buyer-auth GET works as a session probe.
  const res = await buyerFetch('/api/org/platform-fee', { method: 'GET' });
  return res.ok;
}

async function refreshAll() {
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

  // Parallel fetches for the remaining status.
  const [originsRes, corsRes, feeRes, appsRes] = await Promise.all([
    buyerFetch('/api/origins', { method: 'GET' }),
    buyerFetch('/api/org/cors-allow-origins', { method: 'GET' }),
    buyerFetch('/api/org/platform-fee', { method: 'GET' }),
    buyerFetch('/api/org/apps?page=1&limit=50', { method: 'GET' }),
  ]);

  const origins = Array.isArray(originsRes.json?.origins) ? originsRes.json.origins : [];
  const verifiedOrigins = origins.filter((o) => String(o?.status ?? '') === 'verified').length;
  badge('badgeOrigin', verifiedOrigins > 0 ? 'Done' : '!', verifiedOrigins > 0 ? 'good' : 'warn');

  const feeBps = Number(feeRes.json?.platformFeeBps ?? 0);
  const feeWallet = String(feeRes.json?.platformFeeWalletAddress ?? '').trim();
  const feeOk = Number.isFinite(feeBps) && (feeBps <= 0 || feeWallet.length > 0);
  badge('badgeFees', feeOk ? 'Done' : '!', feeOk ? 'good' : 'warn');

  const apps = Array.isArray(appsRes.json?.apps) ? appsRes.json.apps : [];
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

  // Populate publish app select.
  const publishApp = $('publishApp');
  if (publishApp) {
    const cur = String(publishApp.value || '');
    clearNode(publishApp);
    for (const a of apps) {
      const opt = document.createElement('option');
      opt.value = String(a?.id ?? '');
      opt.textContent = String(a?.name ?? a?.slug ?? 'app');
      opt.dataset.slug = String(a?.slug ?? '');
      opt.dataset.taskType = String(a?.taskType ?? '');
      publishApp.appendChild(opt);
    }
    if (cur) publishApp.value = cur;
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
  if (verifiedOrigins <= 0) next = 'origin';
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
    const sel = $('publishApp')?.selectedOptions?.[0];
    const slug = sel?.dataset?.slug ? String(sel.dataset.slug) : '';
    const link = slug ? `/apps/app/${encodeURIComponent(slug)}/` : '/apps/';
    const a = $('btnOpenAppPage');
    if (a) a.setAttribute('href', link);
    await refreshAll();
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
