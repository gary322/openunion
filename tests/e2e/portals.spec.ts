import { test, expect } from '@playwright/test';

test('buyer portal loads', async ({ page }) => {
  await page.goto('/buyer/index.html');
  await expect(page.getByText('Platform Console', { exact: true })).toBeVisible();
  await expect(page.getByText('Quotas (safety caps)', { exact: false })).toBeVisible();
});

test('worker portal loads', async ({ page }) => {
  await page.goto('/worker/index.html');
  await expect(page.locator('text=Worker Console')).toBeVisible();
});

test('admin portal loads', async ({ page }) => {
  await page.goto('/admin/index.html');
  await expect(page.getByText('Admin Console', { exact: true })).toBeVisible();
});
