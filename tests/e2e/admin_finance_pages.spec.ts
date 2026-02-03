import { test, expect } from '@playwright/test';

test('admin payouts page loads', async ({ page }) => {
  await page.goto('/admin/payouts.html');
  await expect(page.getByText('Payouts', { exact: true })).toBeVisible();
  await expect(page.getByText('Admin reconciliation tools.', { exact: false })).toBeVisible();
  await expect(page.locator('#adminToken')).toBeVisible();
});

test('admin disputes page loads', async ({ page }) => {
  await page.goto('/admin/disputes.html');
  await expect(page.getByText('Disputes', { exact: true })).toBeVisible();
  await expect(page.getByText('Admin dispute tools.', { exact: false })).toBeVisible();
  await expect(page.locator('#adminToken')).toBeVisible();
});

