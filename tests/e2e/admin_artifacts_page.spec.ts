import { test, expect } from '@playwright/test';

test('admin artifacts page loads', async ({ page }) => {
  await page.goto('/admin/artifacts.html');
  await expect(page.locator('.title')).toHaveText('Artifacts');
  await expect(page.locator('#adminToken')).toBeVisible();
  await expect(page.locator('#btnQuarantine')).toBeVisible();
  await expect(page.locator('#btnDelete')).toBeVisible();
});
