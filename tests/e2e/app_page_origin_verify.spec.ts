import { test, expect } from '@playwright/test';
import { fillBuyerDemoLogin, openBuyerApiKeysTab, openDetails, startHttpFileOriginServer, fillRequiredAppForm } from './helpers';

test('app page can add + verify a new origin inline (http_file) and publish work', async ({ page }) => {
  test.setTimeout(90_000);

  const originServer = await startHttpFileOriginServer();

  try {
    // Login and mint a buyer API token (stored in localStorage).
    await page.goto('/buyer/index.html');
    await fillBuyerDemoLogin(page);
    await page.click('#btnLogin');
    await expect(page.locator('#loginStatus')).toContainText('ok');

    await openBuyerApiKeysTab(page);
    await page.click('#btnCreateKey');
    await expect(page.locator('#keyStatus')).toContainText('token created');
    await expect(page.locator('#buyerToken')).toHaveValue(/^pw_bu_/);

    // Open a built-in app page and use the inline origin verify flow.
    await page.goto('/apps/app/github/');
    await expect(page.locator('#hdrTitle')).toContainText('GitHub');
    await expect(page.locator('#connectedRow')).toBeVisible();

    await openDetails(page, '#foldPublish');
    await openDetails(page, '#settingsFold');
    await openDetails(page, '#originVerifyDetails');
    await page.fill('#originVerifyUrl', originServer.origin);
    await page.selectOption('#originVerifyMethod', 'http_file');

    const addRespPromise = page.waitForResponse((r) => r.url().includes('/api/origins') && r.request().method() === 'POST');
    await page.click('#btnOriginVerifyAdd');
    const addResp = await addRespPromise;
    expect(addResp.ok()).toBeTruthy();
    const addJson = (await addResp.json()) as any;
    const token = String(addJson?.origin?.token ?? '');
    expect(token).toMatch(/^pw_verify_/);
    originServer.setVerifyToken(token);

    // Should verify successfully and refresh the origin picker.
    await page.click('#btnOriginVerifyCheck');
    await expect(page.locator('#originVerifyStatus')).toContainText('Verified', { timeout: 15_000 });

    await expect
      .poll(async () => {
        return await page.evaluate(() => Array.from((document.getElementById('originSelect') as HTMLSelectElement | null)?.options ?? []).map((o) => o.value));
      })
      .toContain(originServer.origin);

    // Fill the required friendly form fields and publish work using the newly verified origin.
    await openDetails(page, '#foldDescribe');
    await fillRequiredAppForm(page);
    if (await page.locator('#originSelect').isVisible()) {
      await page.selectOption('#originSelect', originServer.origin);
      await expect(page.locator('#originSelect')).toHaveValue(originServer.origin);
    }

    await openDetails(page, '#customPayout');
    await page.fill('#payoutCents', '1200');
    await page.fill('#requiredProofs', '1');
    await page.fill('#title', `App page origin publish ${Date.now()}`);

    const createRespPromise = page.waitForResponse((r) => r.url().endsWith('/api/bounties') && r.request().method() === 'POST');
    const publishRespPromise = page.waitForResponse(
      (r) => r.url().includes('/api/bounties/') && r.url().endsWith('/publish') && r.request().method() === 'POST'
    );
    await page.click('#btnCreatePublish');
    expect((await createRespPromise).ok()).toBeTruthy();
    expect((await publishRespPromise).ok()).toBeTruthy();

    // Publish should land users in Monitor.
    await expect(page.locator('#monitor')).toBeVisible();
  } finally {
    await originServer.close();
  }
});

