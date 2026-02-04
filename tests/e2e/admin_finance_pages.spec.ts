import { test, expect } from '@playwright/test';

test('admin payouts page loads', async ({ page }) => {
  await page.goto('/admin/payouts.html');
  await expect(page.getByRole('heading', { name: 'Payouts', exact: true })).toBeVisible();
  await expect(page.getByText('Triage, retry, and break-glass', { exact: false })).toBeVisible();
  await expect(page.locator('#adminToken')).toBeVisible();
});

test('admin disputes page loads', async ({ page }) => {
  await page.goto('/admin/disputes.html');
  await expect(page.getByRole('heading', { name: 'Disputes', exact: true })).toBeVisible();
  await expect(page.getByText('Resolve disputes', { exact: false })).toBeVisible();
  await expect(page.locator('#adminToken')).toBeVisible();
});
