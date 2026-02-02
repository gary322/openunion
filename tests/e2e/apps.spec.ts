import { test, expect } from '@playwright/test';

test('apps index loads', async ({ page }) => {
  await page.goto('/apps/');
  await expect(page.locator('text=Apps')).toBeVisible();
  await expect(page.locator('text=GitHub Scan')).toBeVisible();
});

test('app page loads (github)', async ({ page }) => {
  await page.goto('/apps/github/');
  await expect(page.locator('text=GitHub Scan')).toBeVisible();
  await expect(page.locator('text=taskDescriptor JSON')).toBeVisible();
});

