import { test, expect } from '@playwright/test';

test('buyer portal loads', async ({ page }) => {
  await page.goto('/buyer/index.html');
  await expect(page.getByText('Buyer Portal', { exact: true })).toBeVisible();
});

test('worker portal loads', async ({ page }) => {
  await page.goto('/worker/index.html');
  await expect(page.locator('text=Worker Portal')).toBeVisible();
});

test('admin portal loads', async ({ page }) => {
  await page.goto('/admin/index.html');
  await expect(page.getByText('Admin Console', { exact: true })).toBeVisible();
});
