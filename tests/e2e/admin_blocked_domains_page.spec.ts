import { test, expect } from '@playwright/test';

test('admin blocked domains page loads', async ({ page }) => {
  await page.goto('/admin/blocked-domains.html');
  await expect(page.getByText('Blocked Domains', { exact: false })).toBeVisible();
  await expect(page.getByText('POST /api/admin/blocked-domains', { exact: false })).toBeVisible();
});

