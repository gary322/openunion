import { test, expect } from '@playwright/test';

test('apps index loads', async ({ page }) => {
  await page.goto('/apps/');
  await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible();

  const grid = page.locator('#grid');
  await expect(grid.getByRole('heading', { name: 'Clips', exact: true })).toBeVisible();
  await expect(grid.getByRole('heading', { name: 'Marketplace', exact: true })).toBeVisible();
  await expect(grid.getByRole('heading', { name: 'Jobs', exact: true })).toBeVisible();
  await expect(grid.getByRole('heading', { name: 'Travel', exact: true })).toBeVisible();
  await expect(grid.getByRole('heading', { name: 'Research', exact: true })).toBeVisible();
  await expect(grid.getByRole('heading', { name: 'GitHub Scan', exact: true })).toBeVisible();
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
    // Built-in pages redirect to the canonical dynamic app page.
    await expect(page).toHaveURL(new RegExp(`/apps/app/${app.slug}/?$`));
    await expect(page.locator('#hdrTitle')).toContainText(app.title);
    // App pages are workflow-first: publishing requires a platform connection.
    await expect(page.locator('#connectRow')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });
}
