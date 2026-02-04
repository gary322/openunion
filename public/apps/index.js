const statusEl = document.getElementById('status');
const grid = document.getElementById('grid');

function renderCard(app) {
  const title = String(app?.name || app?.slug || 'App');
  const desc = String(app?.description || '');
  const slug = String(app?.slug || '');
  const href = app?.dashboardUrl || (slug ? `/apps/app/${encodeURIComponent(slug)}/` : '/apps/');

  const card = document.createElement('article');
  // Keep legacy `.card` for existing E2E selectors; style comes from `.pw-card`.
  card.className = 'pw-card soft card';

  const name = document.createElement('h3');
  name.className = 'pw-app-name';
  name.textContent = title;
  card.appendChild(name);

  const p = document.createElement('p');
  p.className = 'pw-app-desc';
  p.textContent = desc || '—';
  card.appendChild(p);

  const actions = document.createElement('div');
  actions.className = 'pw-actions';

  const open = document.createElement('a');
  open.className = 'pw-btn primary';
  open.href = href;
  open.textContent = 'Open';
  actions.appendChild(open);

  if (String(app?.taskType || '')) {
    const chip = document.createElement('span');
    chip.className = 'pw-chip pw-mono';
    chip.textContent = String(app.taskType);
    actions.appendChild(chip);
  }

  card.appendChild(actions);

  return card;
}

(async () => {
  try {
    if (statusEl) statusEl.textContent = 'Loading apps...';
    const res = await fetch('/api/apps?page=1&limit=200', { credentials: 'include' });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      if (statusEl) statusEl.textContent = `Failed to load apps (${res.status})`;
      return;
    }
    const apps = Array.isArray(json?.apps) ? json.apps : [];
    if (grid) {
      grid.replaceChildren(...apps.map(renderCard));
    }
    if (statusEl) statusEl.textContent = apps.length ? `Loaded ${apps.length} apps` : 'No apps published yet.';
  } catch (_err) {
    if (statusEl) statusEl.textContent = 'Failed to load apps.';
  }
})();
