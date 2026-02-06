import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 360, height: 780 } });

async function expectNoHorizontalScroll(page: any) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth - doc.clientWidth;
  });
  // Allow a tiny tolerance for subpixel rounding.
  expect(overflow).toBeLessThanOrEqual(2);
}

test('mobile: apps marketplace is usable at 360px', async ({ page }) => {
  await page.goto('/apps/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Attach your platform' })).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test('mobile: worker console loads and primary CTA is visible', async ({ page }) => {
  await page.goto('/worker/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Worker Console' })).toBeVisible();
  await expect(page.locator('#home').getByRole('link', { name: 'Find work' })).toBeVisible();
  await expectNoHorizontalScroll(page);
});
