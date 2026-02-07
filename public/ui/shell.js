import { el, fetchJson, getDevMode, initDevMode, setDevMode, storageGet, storageSet, toast, authHeader, LS } from '/ui/pw.js';

function currentPortal() {
  const v = String(document.body?.dataset?.portal ?? '').trim();
  return v || null;
}

function resolveConfigForPortal(portal) {
  if (portal === 'admin') {
    return { endpoint: '/api/admin/resolve', tokenKey: LS.adminToken };
  }
  if (portal === 'buyer') {
    return { endpoint: '/api/org/resolve', tokenKey: LS.buyerToken };
  }
  if (portal === 'worker') {
    return { endpoint: '/api/worker/resolve', tokenKey: LS.workerToken };
  }
  return null;
}

function mountTopbarTools() {
  const inner = document.querySelector('.pw-topbar-inner');
  const nav = document.querySelector('.pw-topnav');
  if (!inner || !nav) return;

  const tools = document.createElement('div');
  tools.className = 'pw-topbar-tools';

  const portal = currentPortal();
  const cfg = portal ? resolveConfigForPortal(portal) : null;
  if (cfg) {
    const search = el('form', { class: 'pw-search', role: 'search' }, [
      el('input', { id: 'pwGlobalSearch', type: 'search', placeholder: 'Search id…' }),
    ]);

    search.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const input = search.querySelector('input');
      const q = String(input?.value ?? '').trim();
      if (!q) return;

      const token = storageGet(cfg.tokenKey, '').trim();
      const res = await fetchJson(`${cfg.endpoint}?id=${encodeURIComponent(q)}`, { headers: { ...authHeader(token) } });
      if (!res.ok) {
        toast(`Search failed (${res.status})`, 'bad');
        return;
      }
      if (!res.json?.found) {
        toast('Not found', 'bad');
        return;
      }
      const href = String(res.json?.href ?? '').trim();
      if (!href) {
        toast('Found but missing link', 'bad');
        return;
      }
      window.location.assign(href);
    });

    tools.appendChild(search);
  }

  const dev = el('button', { type: 'button', class: 'pw-toggle', id: 'pwDevToggle', 'aria-pressed': getDevMode() ? 'true' : 'false' }, [
    el('span', { class: 'pw-toggle-pill' }),
    el('span', { text: 'Dev' }),
  ]);
  dev.addEventListener('click', () => {
    const next = !getDevMode();
    setDevMode(next);
    dev.setAttribute('aria-pressed', next ? 'true' : 'false');
    toast(next ? 'Developer mode on' : 'Developer mode off', next ? 'good' : '');
  });
  tools.appendChild(dev);

  inner.insertBefore(tools, nav.nextSibling);
}

function mountSidebarDrawer() {
  const sidebar = document.querySelector('.pw-sidebar.pw-sidebar-collapsible');
  if (!sidebar) return;

  // The catalog uses the same collapsible sidebar CSS for filters and has its own toggle UI.
  const portal = currentPortal();
  if (portal === 'apps' && document.getElementById('btnFilters')) return;

  const tools = document.querySelector('.pw-topbar-tools');
  if (!tools) return;

  if (!document.getElementById('pwSidebarBackdrop')) {
    const backdrop = document.createElement('div');
    backdrop.className = 'pw-backdrop';
    backdrop.id = 'pwSidebarBackdrop';
    backdrop.addEventListener('click', () => document.body.classList.remove('pw-show-filters'));
    document.body.appendChild(backdrop);
  }

  function setOpen(on) {
    document.body.classList.toggle('pw-show-filters', Boolean(on));
    const btn = document.getElementById('pwSidebarToggle');
    if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  if (!document.getElementById('pwSidebarToggle')) {
    const btn = el('button', { type: 'button', class: 'pw-btn pw-mobile-only', id: 'pwSidebarToggle', 'aria-pressed': 'false' }, [
      'Menu',
    ]);
    btn.addEventListener('click', () => setOpen(!document.body.classList.contains('pw-show-filters')));
    tools.insertBefore(btn, tools.firstChild);
  }

  if (!sidebar.querySelector('.pw-sidebar-close')) {
    const closeRow = el('div', { class: 'pw-row pw-sidebar-close pw-mobile-only' }, [
      el('div', { class: 'pw-kicker', text: 'Menu' }),
      el('button', { type: 'button', class: 'pw-btn', text: 'Close' }),
    ]);
    closeRow.querySelector('button')?.addEventListener('click', () => setOpen(false));
    sidebar.insertBefore(closeRow, sidebar.firstChild);
  }

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') setOpen(false);
  });
}

initDevMode();

// First-party UIs use cookie sessions for interactive auth. Because cookies can outlive localStorage,
// hydrate the CSRF token (stored in localStorage) from the session if needed so users don't get
// stuck in a "not connected" state even though they are signed in.
async function hydrateSessionCsrf() {
  const portal = currentPortal();
  if (portal !== 'apps' && portal !== 'buyer') return;

  const buyerToken = String(storageGet(LS.buyerToken, '') || '').trim();
  if (buyerToken) return; // Token mode doesn't use CSRF.

  try {
    const res = await fetchJson('/api/auth/session', { method: 'GET', credentials: 'include' });
    if (!res.ok) {
      // Avoid stale "connected" UI when the cookie session is gone.
      storageSet(LS.csrfToken, '');
      return;
    }
    const csrf = String(res.json?.csrfToken ?? '').trim();
    if (csrf) storageSet(LS.csrfToken, csrf);
  } catch {
    // Best-effort only: the page can still function in token mode.
  }
}

hydrateSessionCsrf();
mountTopbarTools();
mountSidebarDrawer();
