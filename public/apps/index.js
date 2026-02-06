import { el, formatCents, toast, storageGet, LS } from '/ui/pw.js';

const statusEl = document.getElementById('status');
const statsEl = document.getElementById('stats');
const grid = document.getElementById('grid');

const q = document.getElementById('q');
const btnClear = document.getElementById('btnClear');

const catFilters = document.getElementById('catFilters');
const capFilters = document.getElementById('capFilters');
const onlyUniversal = document.getElementById('onlyUniversal');

const UNIVERSAL_CAPS = new Set(['browser', 'http', 'ffmpeg', 'llm_summarize', 'screenshot']);

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
    // New users should be guided through onboarding (origin verification, fees, app template),
    // then returned to the app page to publish work.
    ev.preventDefault();
    window.location.assign(onboardingHrefFor(appPath));
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

  if (grid) grid.replaceChildren(...visible.map(renderCard));

  const total = apps.length;
  const uwCount = apps.filter(isUniversalCompatible).length;
  const msg = `${visible.length} shown • ${total} total • ${uwCount} Universal Worker compatible`;
  if (statsEl) statsEl.textContent = msg;
  setStatus(visible.length ? '' : 'No apps match your filters.');
}

async function load() {
  try {
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

    setStatus('');
    render();
  } catch (_err) {
    setStatus('Failed to load apps.', 'bad');
  }
}

load();
