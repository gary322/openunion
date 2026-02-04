import { test, expect } from '@playwright/test';

test('admin blocked domains page loads', async ({ page }) => {
  await page.goto('/admin/blocked-domains.html');
  await expect(page.getByRole('heading', { name: 'Blocked Domains', exact: true })).toBeVisible();
  await expect(page.getByText('Global denylist', { exact: false })).toBeVisible();
  await expect(page.getByText('Save blocked domain', { exact: false })).toBeVisible();
});
