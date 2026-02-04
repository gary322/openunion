import { test, expect } from '@playwright/test';

test('admin alerts page loads', async ({ page }) => {
  await page.goto('/admin/alerts.html');
  await expect(page.getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible();
  await expect(page.getByText('Internal alarm inbox', { exact: false })).toBeVisible();
  await expect(page.locator('#adminToken')).toBeVisible();

  // Exercise the real API call so Postgres-only query issues are caught in CI.
  await page.fill('#adminToken', 'pw_adm_internal');
  await page.click('#btnSave');
  await expect(page.locator('#authStatus')).toContainText('saved');
  await page.click('#btnList');
  await expect(page.locator('#listStatus')).toContainText('ok');
  await expect(page.locator('#out')).toContainText('"alerts"');
});
