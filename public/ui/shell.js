import { el, fetchJson, getDevMode, initDevMode, setDevMode, storageGet, toast, authHeader, LS } from '/ui/pw.js';

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

initDevMode();
mountTopbarTools();

