const statusEl = document.getElementById('status');
const grid = document.getElementById('grid');

function card(app) {
  const title = String(app?.name || app?.slug || 'App');
  const desc = String(app?.description || '');
  const slug = String(app?.slug || '');
  const href = app?.dashboardUrl || (slug ? `/apps/app/${encodeURIComponent(slug)}/` : '/apps/');
  return `
    <div class="card">
      <div style="font-weight:700">${title}</div>
      <div class="muted">${desc}</div>
      <div style="margin-top:10px"><a href="${href}">Open</a></div>
    </div>
  `;
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
    if (grid) grid.innerHTML = apps.map(card).join('');
    if (statusEl) statusEl.textContent = apps.length ? `Loaded ${apps.length} apps` : 'No apps published yet.';
  } catch (_err) {
    if (statusEl) statusEl.textContent = 'Failed to load apps.';
  }
})();

