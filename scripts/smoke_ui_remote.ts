// Remote UI smoke test for a deployed Proofwork environment.
//
// This is intentionally "shallow": it verifies that key web UIs load and render
// their expected titles (i.e. static asset serving + basic JS bootstrap).
//
// Usage:
//   BASE_URL=http://... npm run smoke:remote:ui
//   npm run smoke:remote:ui -- --base-url http://...

import { chromium } from 'playwright';

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/$/, '');
}

async function main() {
  const baseUrl = normalizeBaseUrl(argValue('--base-url') ?? process.env.BASE_URL ?? 'http://localhost:3000');

  const checks: Array<{ path: string; titleIncludes: string }> = [
    { path: '/buyer/', titleIncludes: 'Buyer Portal' },
    { path: '/worker/', titleIncludes: 'Worker Portal' },
    { path: '/admin/', titleIncludes: 'Admin Console' },
    { path: '/admin/apps.html', titleIncludes: 'Apps Dashboard' },
    { path: '/admin/descriptor-builder.html', titleIncludes: 'Descriptor Builder' },
    { path: '/apps/', titleIncludes: 'Apps' },
    { path: '/apps/github/', titleIncludes: 'GitHub' },
  ];

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    for (const c of checks) {
      const url = `${baseUrl}${c.path}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      // Allow minimal JS bootstraps (e.g., /apps/* pages set document.title in a module).
      await page.waitForTimeout(200);
      const title = await page.title();
      if (!title.includes(c.titleIncludes)) {
        throw new Error(`ui_smoke_failed:${c.path}:expected_title_includes:${c.titleIncludes}:got:${title}`);
      }
      console.log(`[ui-smoke] ok ${c.path} (${title})`);
    }
  } finally {
    await page.close();
    await browser.close();
  }

  console.log('[ui-smoke] OK');
}

main().catch((err) => {
  console.error('[ui-smoke] FAILED', err);
  process.exitCode = 1;
});

