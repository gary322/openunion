import { test, expect } from '@playwright/test';

test('admin alerts page loads', async ({ page }) => {
  await page.goto('/admin/alerts.html');
  await expect(page.getByText('Alerts', { exact: true })).toBeVisible();
  await expect(page.getByText('Internal alarm inbox', { exact: false })).toBeVisible();
  await expect(page.locator('#adminToken')).toBeVisible();
});

