import { test, expect } from '@playwright/test';

test('admin apps dashboard loads and shows metrics', async ({ page }) => {
  await page.goto('/admin/apps.html');
  await expect(page.getByRole('heading', { name: 'Apps Dashboard', exact: true })).toBeVisible();

  // Use the dev default admin token (E2E server runs non-production).
  await page.fill('#adminToken', 'pw_adm_internal');
  await page.click('#btnSave');
  await page.click('#btnRefresh');

  await expect(page.locator('#status')).toContainText('updated');
  await expect
    .poll(async () => await page.locator('#rows tr').count(), { timeout: 10_000 })
    .toBeGreaterThan(0);
});
