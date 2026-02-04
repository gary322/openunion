import { test, expect } from '@playwright/test';

test('buyer onboarding page loads', async ({ page }) => {
  await page.goto('/buyer/onboarding.html');
  await expect(page.getByText('Platform onboarding', { exact: false })).toBeVisible();
  // Ensure guided checklist content is present (stable signal).
  await expect(page.getByText('Create org + get a token', { exact: false })).toBeVisible();
});
