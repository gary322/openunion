import { test, expect } from '@playwright/test';

test('apps marketplace: unconnected users get a choice (sign in or onboarding)', async ({ page }) => {
  await page.goto('/apps/');

  const card = page.locator('.card').filter({ hasText: 'GitHub Scan' }).first();
  await expect(card).toBeVisible();

  await card.getByRole('link', { name: 'Create work' }).click();

  // We show a choice modal so already-onboarded platforms can sign in directly on the app page.
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start onboarding' })).toBeVisible();

  // New platforms should be guided through onboarding (with a return link).
  await page.getByRole('button', { name: 'Start onboarding' }).click();
  await expect(page).toHaveURL(/\/buyer\/onboarding\.html\?next=%2Fapps%2Fapp%2Fgithub%2F/);

  // Onboarding should surface a "continue" CTA back to the app page even before connecting.
  const dbg = await page.evaluate(() => {
    const next = new URLSearchParams(window.location.search).get('next');
    const dismissed = window.localStorage.getItem('pw_onboarding_next_dismissed');
    const hidden = Boolean((document.getElementById('nextAppCard') as any)?.hidden);
    const href = (document.getElementById('nextAppLink') as HTMLAnchorElement | null)?.getAttribute('href') || '';
    const top = (document.getElementById('wizTopStatus') as HTMLElement | null)?.textContent || '';
    return { next, dismissed, hidden, href, top };
  });

  expect(dbg.next).toBe('/apps/app/github/');
  expect(dbg.dismissed).not.toBe('1');
  expect(dbg.hidden).toBe(false);
  expect(dbg.href).toBe('/apps/app/github/');

  // Returning platforms should be able to choose sign-in and go straight to the app page.
  await page.goto('/apps/');
  await card.getByRole('link', { name: 'Create work' }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/apps\/app\/github\/$/);
  await expect(page.locator('#connectRow')).toBeVisible();
});
