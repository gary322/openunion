import { test, expect } from '@playwright/test';

test('apps index loads', async ({ page }) => {
  await page.goto('/apps/');
  await expect(page.getByText('Apps', { exact: true })).toBeVisible();
  await expect(page.getByText('Clips', { exact: true })).toBeVisible();
  await expect(page.getByText('Marketplace', { exact: true })).toBeVisible();
  await expect(page.getByText('Jobs', { exact: true })).toBeVisible();
  await expect(page.getByText('Travel', { exact: true })).toBeVisible();
  await expect(page.getByText('Research', { exact: true })).toBeVisible();
  await expect(page.getByText('GitHub Scan', { exact: true })).toBeVisible();
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
