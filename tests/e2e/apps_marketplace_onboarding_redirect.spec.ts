import { test, expect } from '@playwright/test';

test('apps marketplace: unconnected users are routed to onboarding with a safe return link', async ({ page }) => {
  await page.goto('/apps/');

  const card = page.locator('.card').filter({ hasText: 'GitHub Scan' }).first();
  await expect(card).toBeVisible();

  await card.getByRole('link', { name: 'Create work' }).click();

  // New platforms should be guided through onboarding (with a return link).
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

  // If the browser already has Proofwork state (e.g. CSRF/session), catalog links go straight to app pages.
  await page.goto('/apps/');
  await page.evaluate(() => {
    window.localStorage.setItem('pw_csrf_token', 'csrf_dummy');
    // Some UI paths treat a stored buyer token as equivalent "connected" state.
    // Use a dummy value to make this test robust against minor heuristic changes.
    window.localStorage.setItem('pw_buyer_token', 'buyer_dummy');
  });
  // Reload so any "next action" preflight computed on page-load sees the token.
  await page.reload();

  const card2 = page.locator('.card').filter({ hasText: 'GitHub Scan' }).first();
  await expect(card2).toBeVisible();
  await card2.getByRole('link', { name: 'Create work' }).click();
  await expect(page).toHaveURL(/\/apps\/app\/github\/$/);
  await expect(page.locator('#connectRow')).toBeVisible();
});
