import { initAppPage } from '/apps/app_page.js';

const cfgEl = document.getElementById('appConfig');
if (!cfgEl) throw new Error('missing appConfig');
const cfg = JSON.parse(cfgEl.textContent || '{}');

document.title = `Proofwork • ${cfg.title || 'App'}`;
const hdrTitle = document.getElementById('hdrTitle');
const hdrDesc = document.getElementById('hdrDesc');
if (hdrTitle) hdrTitle.textContent = cfg.title || '';
if (hdrDesc) hdrDesc.textContent = cfg.description || '';
const descBox = document.getElementById('description');
if (descBox) descBox.value = cfg.description || '';

await initAppPage(cfg);
