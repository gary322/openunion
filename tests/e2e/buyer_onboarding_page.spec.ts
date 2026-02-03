import { test, expect } from '@playwright/test';

test('buyer onboarding page loads', async ({ page }) => {
  await page.goto('/buyer/onboarding.html');
  await expect(page.getByText('Platform onboarding', { exact: false })).toBeVisible();
  // Ensure checklist content is present (stable signal).
  await expect(page.getByText('POST /api/org/register', { exact: false })).toBeVisible();
});
