import { test, expect } from '@playwright/test';

test('apps index loads', async ({ page }) => {
  await page.goto('/apps/');
  await expect(page.locator('text=Apps')).toBeVisible();
  await expect(page.locator('text=Clips')).toBeVisible();
  await expect(page.locator('text=Marketplace')).toBeVisible();
  await expect(page.locator('text=Jobs')).toBeVisible();
  await expect(page.locator('text=Travel')).toBeVisible();
  await expect(page.locator('text=Research')).toBeVisible();
  await expect(page.locator('text=GitHub Scan')).toBeVisible();
});

for (const app of [
  { slug: 'clips', title: 'Clips' },
  { slug: 'marketplace', title: 'Marketplace' },
  { slug: 'jobs', title: 'Jobs' },
  { slug: 'travel', title: 'Travel' },
  { slug: 'research', title: 'Research' },
  { slug: 'github', title: 'GitHub Scan' },
]) {
  test(`app page loads (${app.slug})`, async ({ page }) => {
    await page.goto(`/apps/${app.slug}/`);
    await expect(page.locator('#hdrTitle')).toContainText(app.title);
    await expect(page.locator('text=taskDescriptor JSON')).toBeVisible();
  });
}
