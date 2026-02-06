import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Axe injects scripts into the page. Our production CSP disallows inline scripts, so we
// intentionally bypass CSP only for these accessibility checks.
test.use({ bypassCSP: true });

async function expectNoSeriousViolations(page: any, urlPath: string) {
  await page.goto(urlPath, { waitUntil: 'domcontentloaded' });

  const results = await new AxeBuilder({ page })
    // We care about real user impact. Keep the bar high but avoid noisy best-practice nags.
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();

  const bad = (results.violations || []).filter((v: any) => ['serious', 'critical'].includes(String(v.impact)));

  if (bad.length) {
    // Make failures actionable in CI logs.
    const summary = bad.map((v: any) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes?.length ?? 0 }));
    // eslint-disable-next-line no-console
    console.error('[a11y] violations', JSON.stringify(summary, null, 2));
  }

  expect(bad, `A11y violations on ${urlPath}`).toEqual([]);
}

test('a11y: apps marketplace', async ({ page }) => {
  await expectNoSeriousViolations(page, '/apps/');
});

test('a11y: buyer portal', async ({ page }) => {
  await expectNoSeriousViolations(page, '/buyer/');
});

test('a11y: worker portal', async ({ page }) => {
  await expectNoSeriousViolations(page, '/worker/');
});

