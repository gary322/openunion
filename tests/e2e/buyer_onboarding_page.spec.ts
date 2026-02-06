import { test, expect } from '@playwright/test';

test('buyer onboarding page loads', async ({ page }) => {
  await page.goto('/buyer/onboarding.html');
  await expect(page.getByText('Platform onboarding', { exact: false })).toBeVisible();
  // Stable signals: wizard steps exist.
  await expect(page.getByRole('heading', { name: 'Connect' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Verify origin' })).toBeVisible();
});
