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
    { path: '/buyer/', titleIncludes: 'Platform Console' },
    { path: '/worker/', titleIncludes: 'Worker Console' },
    { path: '/admin/', titleIncludes: 'Admin Console' },
    { path: '/admin/apps.html', titleIncludes: 'Apps Dashboard' },
    { path: '/admin/descriptor-builder.html', titleIncludes: 'Descriptor Builder' },
    { path: '/apps/', titleIncludes: 'Apps' },
    // Built-in /apps/<slug>/ pages meta-refresh to the canonical dynamic app page. Smoke should
    // hit the canonical page directly to avoid timing flakes during the redirect.
    { path: '/apps/app/github/', titleIncludes: 'GitHub' },
    { path: '/docs/', titleIncludes: 'Docs' },
  ];

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    for (const c of checks) {
      const url = `${baseUrl}${c.path}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      // Allow minimal JS bootstraps (e.g., /apps/* pages set document.title in a module).
      // Network + DB fetches can make this >200ms on real deployments, so wait up to a short
      // bound instead of a fixed sleep to reduce flakes.
      try {
        await page.waitForFunction((expected) => document.title.includes(expected), c.titleIncludes, { timeout: 5_000 });
      } catch {
        // Best-effort: we'll validate the observed title below for a deterministic failure.
      }
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
