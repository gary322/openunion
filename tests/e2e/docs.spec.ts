import { test, expect } from '@playwright/test';

test('docs index loads and links key runbooks', async ({ page }) => {
  await page.goto('/docs/');
  await expect(page.getByRole('heading', { name: 'Docs', exact: true })).toBeVisible();

  await expect(page.getByRole('link', { name: 'Third-party onboarding' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Task descriptor' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Universal Worker' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Verifier gateway' }).first()).toBeVisible();

  // The docs viewer should render Markdown into a readable page (not a raw .md download).
  await page.getByRole('link', { name: 'Third-party onboarding' }).first().click();
  await expect(page.getByRole('heading', { name: 'Third-Party Platform Onboarding (Self-Serve)' })).toBeVisible();
});
