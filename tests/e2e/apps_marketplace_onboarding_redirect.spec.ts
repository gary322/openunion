import { test, expect } from '@playwright/test';

test('apps marketplace: Create work redirects unconnected users to onboarding with next', async ({ page }) => {
  await page.goto('/apps/');

  const card = page.locator('.card').filter({ hasText: 'GitHub Scan' }).first();
  await expect(card).toBeVisible();

  await card.getByRole('link', { name: 'Create work' }).click();

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
});
