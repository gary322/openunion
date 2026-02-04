import { initAppPage } from '/apps/app_page.js';

const cfgEl = document.getElementById('appConfig');
if (!cfgEl) throw new Error('missing appConfig');
const cfg = JSON.parse(cfgEl.textContent || '{}');

function inferSlugFromLocation() {
  const path = String(window.location.pathname || '');
  // /apps/app/<slug>/ OR /apps/<slug>/ (legacy built-in)
  const parts = path.split('/').filter(Boolean);
  const appsIdx = parts.indexOf('apps');
  if (appsIdx === -1) return null;
  if (parts[appsIdx + 1] === 'app') return parts[appsIdx + 2] || null;
  return parts[appsIdx + 1] || null;
}

async function fetchApp(slug) {
  if (!slug) return null;
  const res = await fetch(`/api/apps/${encodeURIComponent(slug)}`, { credentials: 'omit' });
  const json = await res.json().catch(() => null);
  if (!res.ok) return null;
  return json?.app || null;
}

const slug = (cfg.slug && String(cfg.slug)) || inferSlugFromLocation();
const app = await fetchApp(slug);

const merged = app
  ? {
      ...cfg,
      slug: app.slug,
      taskType: app.taskType,
      title: app.name,
      titlePrefix: app.name,
      description: app.description || '',
      defaultDescriptor: app.defaultDescriptor || {},
      uiSchema: app.uiSchema || {},
    }
  : cfg;

document.title = `Proofwork • ${merged.title || 'App'}`;
const hdrTitle = document.getElementById('hdrTitle');
const hdrDesc = document.getElementById('hdrDesc');
if (hdrTitle) hdrTitle.textContent = merged.title || '';
if (hdrDesc) hdrDesc.textContent = merged.description || '';

await initAppPage(merged);
