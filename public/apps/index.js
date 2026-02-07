import { el, formatCents, toast, storageGet, storageSet, LS } from '/ui/pw.js';

const statusEl = document.getElementById('status');
const statsEl = document.getElementById('stats');
const grid = document.getElementById('grid');

const q = document.getElementById('q');
const btnClear = document.getElementById('btnClear');

const catFilters = document.getElementById('catFilters');
const capFilters = document.getElementById('capFilters');
const onlyUniversal = document.getElementById('onlyUniversal');
const btnFilters = document.getElementById('btnFilters');
const btnCloseFilters = document.getElementById('btnCloseFilters');
const filtersBackdrop = document.getElementById('filtersBackdrop');

const UNIVERSAL_CAPS = new Set(['browser', 'http', 'ffmpeg', 'llm_summarize', 'screenshot']);

const LS_CREATEWORK_FLOW = 'pw_apps_creatework_flow'; // '', 'signin', 'onboarding'

function hasBuyerCreds() {
  const token = String(storageGet(LS.buyerToken, '') || '').trim();
  const csrf = String(storageGet(LS.csrfToken, '') || '').trim();
  return Boolean(token || csrf);
}

function onboardingHrefFor(nextPath) {
  // Only allow same-origin, path-only redirects.
  const p = String(nextPath || '').trim();
  const safe = p.startsWith('/') && !p.startsWith('//') ? p : '/apps/';
  return `/buyer/onboarding.html?next=${encodeURIComponent(safe)}`;
}

function getCategory(app) {
  const cat = app?.uiSchema?.category;
  return String(cat || 'Uncategorized');
}

function getCaps(app) {
  const caps = app?.defaultDescriptor?.capability_tags;
  return Array.isArray(caps) ? caps.map(String) : [];
}

function showCreateWorkChoice({ appName, appPath }) {
  const backdrop = el('div', { class: 'pw-modal-backdrop', 'data-modal': '1' });
  const modal = el('div', { class: 'pw-modal', role: 'dialog', 'aria-modal': 'true' }, [
    el('h3', { text: 'Publish work' }),
    el('p', { class: 'pw-modal-sub' }, [
      `You're about to publish a bounty for `,
      el('span', { class: 'pw-mono', text: String(appName || 'this app') }),
      `. If you're already onboarded, sign in and continue. If you're new, start onboarding first.`,
    ]),
  ]);

  const remember = el('label', { class: 'pw-check' }, [
    el('input', { type: 'checkbox', id: 'pwRememberChoice' }),
    el('span', { text: 'Remember my choice' }),
  ]);

  const btnSignIn = el('button', { type: 'button', class: 'pw-btn primary', id: 'pwChoiceSignin' }, ['Sign in']);
  const btnOnboarding = el('button', { type: 'button', class: 'pw-btn', id: 'pwChoiceOnboarding' }, ['Start onboarding']);
  const btnCancel = el('button', { type: 'button', class: 'pw-btn', id: 'pwChoiceCancel' }, ['Cancel']);

  const actions = el('div', { class: 'pw-modal-actions' }, [btnSignIn, btnOnboarding, btnCancel]);
  const footer = el('div', { class: 'pw-modal-footer' }, [
    remember,
    el('div', { class: 'pw-muted' }, ['Tip: Onboarding is required to verify your domain and set your fee cut.']),
  ]);

  modal.appendChild(actions);
  modal.appendChild(footer);

  function close() {
    try {
      backdrop.remove();
      modal.remove();
    } catch {
      // ignore
    }
    document.removeEventListener('keydown', onKeyDown);
  }

  function saveChoice(flow) {
    const on = Boolean((remember.querySelector('input') || {}).checked);
    if (on) storageSet(LS_CREATEWORK_FLOW, String(flow));
  }

  function go(href) {
    close();
    window.location.assign(href);
  }

  function onKeyDown(ev) {
    if (ev.key === 'Escape') close();
  }

  btnCancel.addEventListener('click', () => close());
  backdrop.addEventListener('click', () => close());
  btnSignIn.addEventListener('click', () => {
    saveChoice('signin');
    go(appPath);
  });
  btnOnboarding.addEventListener('click', () => {
    saveChoice('onboarding');
    go(onboardingHrefFor(appPath));
  });

  document.addEventListener('keydown', onKeyDown);
  document.body.appendChild(backdrop);
  document.body.appendChild(modal);
  btnSignIn.focus();
}

function isUniversalCompatible(app) {
  const caps = getCaps(app);
  if (!caps.length) return false;
  return caps.every((c) => UNIVERSAL_CAPS.has(String(c)));
}

function getDefaultPayoutCents(app) {
  const cents = app?.uiSchema?.bounty_defaults?.payout_cents;
  const n = Number(cents);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

function renderFilterList(root, items, selected, { idPrefix, labelPrefix } = {}) {
  const nodes = [];
  for (const name of items) {
    const id = `${idPrefix || 'f'}_${name.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
    const input = el('input', { id, type: 'checkbox', value: name });
    input.checked = selected.has(name);
    input.addEventListener('change', () => {
      if (input.checked) selected.add(name);
      else selected.delete(name);
      render();
    });
    nodes.push(
      el('label', { class: 'pw-check' }, [
        input,
        el('span', { text: labelPrefix ? `${labelPrefix}${name}` : name }),
      ])
    );
  }
  root?.replaceChildren(...nodes);
}

function renderCard(app) {
  const title = String(app?.name || app?.slug || 'App');
  const desc = String(app?.description || '');
  const slug = String(app?.slug || '');
  const appPath = slug ? `/apps/app/${encodeURIComponent(slug)}/` : '/apps/';
  const href = app?.dashboardUrl || appPath;

  const cat = getCategory(app);
  const caps = getCaps(app);
  const payout = getDefaultPayoutCents(app);

  const card = el('article', { class: 'pw-card soft card' }, []);

  const head = el('div', { class: 'pw-card-title' }, [
    el('h3', { class: 'pw-app-name', text: title }),
    el('span', { class: 'pw-kicker' }, [cat]),
  ]);
  card.appendChild(head);

  if (desc) card.appendChild(el('p', { class: 'pw-app-desc', text: desc }));

  const chips = el('div', { class: 'pw-chips' }, []);
  if (isUniversalCompatible(app)) chips.appendChild(el('span', { class: 'pw-chip good', text: 'Universal Worker' }));
  if (String(app?.taskType || '')) chips.appendChild(el('span', { class: 'pw-chip pw-mono', text: String(app.taskType) }));
  if (payout !== null) chips.appendChild(el('span', { class: 'pw-chip', text: `Typical payout: ${formatCents(payout)}` }));
  for (const c of caps.slice(0, 6)) chips.appendChild(el('span', { class: 'pw-chip faint pw-mono', text: c }));
  if (caps.length > 6) chips.appendChild(el('span', { class: 'pw-chip faint', text: `+${caps.length - 6}` }));
  card.appendChild(chips);

  const actions = el('div', { class: 'pw-actions' }, []);
  const open = el('a', { class: 'pw-btn primary', href: appPath }, ['Create work']);
  open.addEventListener('click', (ev) => {
    if (hasBuyerCreds()) return;
    const pref = String(storageGet(LS_CREATEWORK_FLOW, '') || '').trim();
    if (pref === 'signin') return; // Follow the link (app page can sign in).
    ev.preventDefault();
    if (pref === 'onboarding') {
      window.location.assign(onboardingHrefFor(appPath));
      return;
    }
    showCreateWorkChoice({ appName: title, appPath });
  });
  actions.appendChild(open);
  const learn = el('a', { class: 'pw-btn', href }, ['Details']);
  actions.appendChild(learn);
  card.appendChild(actions);

  return card;
}

let apps = [];
let cats = [];
let capsAll = [];

const selectedCats = new Set();
const selectedCaps = new Set();

function setStatus(text, kind = '') {
  if (!statusEl) return;
  statusEl.textContent = text || '';
  statusEl.classList.remove('good', 'bad');
  if (kind) statusEl.classList.add(kind);
}

function setFiltersOpen(on) {
  document.body.classList.toggle('pw-show-filters', Boolean(on));
}

function renderSkeletonGrid(count = 9) {
  if (!grid) return;
  const nodes = [];
  for (let i = 0; i < count; i++) {
    nodes.push(
      el('article', { class: 'pw-card soft card' }, [
        el('div', { class: 'pw-card-title' }, [
          el('div', { class: 'pw-skeleton pw-skeleton-line lg' }),
          el('div', { class: 'pw-skeleton pw-skeleton-line sm' }),
        ]),
        el('div', { class: 'pw-skeleton pw-skeleton-line lg' }),
        el('div', { class: 'pw-skeleton pw-skeleton-line' }),
        el('div', { class: 'pw-actions' }, [
          el('div', { class: 'pw-skeleton pw-skeleton-pill md' }),
          el('div', { class: 'pw-skeleton pw-skeleton-pill sm' }),
        ]),
      ])
    );
  }
  grid.replaceChildren(...nodes);
}

function renderEmptyState({ title, subtitle } = {}) {
  if (!grid) return;
  const card = el('article', { class: 'pw-card soft card pw-span-all' }, [
    el('div', { class: 'pw-card-title' }, [
      el('h3', { text: title || 'No apps match your filters.' }),
      el('span', { class: 'pw-kicker', text: subtitle || 'Try clearing filters or browsing the full catalog.' }),
    ]),
    el('div', { class: 'pw-actions' }, [
      el('button', { class: 'pw-btn', type: 'button', id: 'btnEmptyClear' }, ['Clear filters']),
      el('a', { class: 'pw-btn primary', href: '/buyer/onboarding.html' }, ['Attach your platform']),
    ]),
  ]);
  grid.replaceChildren(card);
  card.querySelector('#btnEmptyClear')?.addEventListener('click', () => btnClear?.click());
}

function render() {
  const needle = norm(q?.value);
  const onlyUW = Boolean(onlyUniversal?.checked);

  const visible = apps.filter((a) => {
    const cat = getCategory(a);
    if (selectedCats.size && !selectedCats.has(cat)) return false;

    const caps = getCaps(a);
    if (selectedCaps.size) {
      for (const c of selectedCaps) {
        if (!caps.includes(c)) return false;
      }
    }
    if (onlyUW && !isUniversalCompatible(a)) return false;

    if (needle) {
      const hay = [
        a?.name,
        a?.slug,
        a?.description,
        a?.taskType,
        cat,
        ...caps,
      ]
        .map(norm)
        .join(' ');
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  if (grid) {
    if (apps.length && visible.length === 0) renderEmptyState();
    else grid.replaceChildren(...visible.map(renderCard));
  }

  const total = apps.length;
  const uwCount = apps.filter(isUniversalCompatible).length;
  const msg = `${visible.length} shown • ${total} total • ${uwCount} Universal Worker compatible`;
  if (statsEl) statsEl.textContent = msg;
  setStatus(visible.length ? '' : 'No apps match your filters.');
}

async function load() {
  try {
    renderSkeletonGrid();
    setStatus('Loading apps…');
    const res = await fetch('/api/apps?page=1&limit=200', { credentials: 'include' });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      setStatus(`Failed to load apps (${res.status})`, 'bad');
      return;
    }
    apps = Array.isArray(json?.apps) ? json.apps : [];

    const catSet = new Set();
    const capSet = new Set();
    for (const a of apps) {
      catSet.add(getCategory(a));
      for (const c of getCaps(a)) capSet.add(c);
    }
    cats = Array.from(catSet).sort((a, b) => a.localeCompare(b));
    capsAll = Array.from(capSet).sort((a, b) => a.localeCompare(b));

    renderFilterList(catFilters, cats, selectedCats, { idPrefix: 'cat_' });
    renderFilterList(capFilters, capsAll, selectedCaps, { idPrefix: 'cap_' });

    q?.addEventListener('input', () => render());
    onlyUniversal?.addEventListener('change', () => render());
    btnClear?.addEventListener('click', () => {
      if (q) q.value = '';
      selectedCats.clear();
      selectedCaps.clear();
      if (onlyUniversal) onlyUniversal.checked = false;
      renderFilterList(catFilters, cats, selectedCats, { idPrefix: 'cat_' });
      renderFilterList(capFilters, capsAll, selectedCaps, { idPrefix: 'cap_' });
      render();
      toast('Cleared filters');
    });

    // Mobile filter drawer toggles.
    btnFilters?.addEventListener('click', () => setFiltersOpen(true));
    btnCloseFilters?.addEventListener('click', () => setFiltersOpen(false));
    filtersBackdrop?.addEventListener('click', () => setFiltersOpen(false));

    setStatus('');
    render();
  } catch (_err) {
    setStatus('Failed to load apps.', 'bad');
  }
}

load();
