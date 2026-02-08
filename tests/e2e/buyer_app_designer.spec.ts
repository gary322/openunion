import { test, expect } from '@playwright/test';
import { fillBuyerDemoLogin, fillRequiredAppForm, gotoBuyerView, openBuyerApiKeysTab, openDetails, startHttpFileOriginServer } from './helpers';

test('buyer can design an app form without JSON (app designer) and publish from the dynamic app page', async ({ page }) => {
  test.setTimeout(120_000);

  const originServer = await startHttpFileOriginServer();
  const origin = originServer.origin;

  try {
    // Buyer portal: sign in and mint a buyer API token.
    await page.goto('/buyer/index.html');
    await fillBuyerDemoLogin(page);
    await page.click('#btnLogin');
    await expect(page.locator('#loginStatus')).toContainText('ok');

    await openBuyerApiKeysTab(page);
    await page.click('#btnCreateKey');
    await expect(page.locator('#keyStatus')).toContainText('token created');
    await expect(page.locator('#buyerToken')).toHaveValue(/^pw_bu_/);

    // Add + verify origin via http_file.
    await gotoBuyerView(page, 'integrations');
    await openDetails(page, '#foldOrigins');
    await page.fill('#originUrl', origin);
    await page.selectOption('#originMethod', 'http_file');

    const addOriginRespPromise = page.waitForResponse((r) => r.url().includes('/api/origins') && r.request().method() === 'POST');
    await page.click('#btnAddOrigin');
    const addOriginResp = await addOriginRespPromise;
    expect(addOriginResp.ok()).toBeTruthy();
    const addOriginJson = (await addOriginResp.json()) as any;
    const verifyToken = String(addOriginJson?.origin?.token ?? '');
    expect(verifyToken).toMatch(/^pw_verify_/);
    originServer.setVerifyToken(verifyToken);

    const originRow = page.locator('#originsTbody tr').filter({ hasText: origin }).first();
    await originRow.getByRole('button', { name: 'Check' }).click();
    await expect(page.locator('#originStatus')).toContainText('status=verified');

    // Apps registry: create an app using the "Design the form" builder.
    await gotoBuyerView(page, 'apps');
    await openDetails(page, '#foldApps');

    const appName = `Designer App ${Date.now()}`;
    await page.fill('#appName', appName);
    await expect(page.locator('#appTemplateGrid')).toBeVisible();
    await page.locator('#appTemplateGrid').getByRole('button', { name: /^Custom/i }).click();

    // Wait for the friendly-form builder to appear.
    await expect(page.locator('#appFieldsList')).toBeVisible();

    // Add a required URL field.
    await page.click('#btnAppAddField');
    const fieldRows = page.locator('#appFieldsList [data-field-card="1"]');
    await expect(fieldRows).toHaveCount(2);

    const newRow = fieldRows.nth(1);
    await newRow.locator('[data-col="label"]').fill('Target URL');
    await newRow.locator('[data-col="type"]').selectOption('url');
    await newRow.locator('[data-col="required"]').check();
    await newRow.locator('[data-col="placeholder"]').fill('https://example.com');

    // Open "Outputs, capabilities, and defaults" and toggle an extra capability.
    await openDetails(page, '#appOutputsDetails');
    await page.locator('#appCapsWrap button', { hasText: 'Screenshot' }).click();

    // Set bounty defaults so app pages are 1-click publish for job creators.
    await page.fill('#appDefaultPayoutCents', '1200');
    await page.fill('#appDefaultRequiredProofs', '1');

    // Ensure preview reflects the field labels (visible, no JSON inspection required).
    await expect(page.locator('#appPreviewBody')).toContainText('Target URL');

    const createAppRespPromise = page.waitForResponse((r) => r.url().endsWith('/api/org/apps') && r.request().method() === 'POST');
    await page.click('#btnCreateOrgApp');
    const createAppResp = await createAppRespPromise;
    expect(createAppResp.ok()).toBeTruthy();
    await expect(page.locator('#appsStatus')).toContainText('created app');

    // Public apps index should include this app (public=true by default).
    await page.goto('/apps/');
    await expect(page.getByText(appName, { exact: true })).toBeVisible();

    // Open the dynamic app page.
    const card = page.locator('.card').filter({ hasText: appName });
    await card.locator('a', { hasText: 'Details' }).click();
    await expect(page.locator('#hdrTitle')).toContainText(appName);

    // Connected state should be visible because buyer token is stored in localStorage.
    await expect(page.locator('#connectedRow')).toBeVisible();

    await openDetails(page, '#foldDescribe');
    await expect(page.getByText('Target URL', { exact: false })).toBeVisible();
    await fillRequiredAppForm(page);

    await openDetails(page, '#foldPublish');
    await openDetails(page, '#settingsFold');

    // Select the verified origin we just proved via http_file.
    await expect
      .poll(async () => {
        return await page.evaluate(() => Array.from((document.getElementById('originSelect') as HTMLSelectElement | null)?.options ?? []).map((o) => o.value));
      })
      .toContain(origin);
    if (await page.locator('#originSelect').isVisible()) {
      await page.selectOption('#originSelect', origin);
      await expect(page.locator('#originSelect')).toHaveValue(origin);
    } else {
      // The single-origin UI may display host-only, so match on the host portion.
      const u = new URL(origin);
      await expect(page.locator('#originSingleText')).toContainText(u.host);
    }

    const title = `Designer bounty ${Date.now()}`;
    await page.fill('#title', title);

    const createRespPromise = page.waitForResponse((r) => r.url().endsWith('/api/bounties') && r.request().method() === 'POST');
    const publishRespPromise = page.waitForResponse(
      (r) => r.url().includes('/api/bounties/') && r.url().endsWith('/publish') && r.request().method() === 'POST'
    );
    await page.click('#btnCreatePublish');
    expect((await createRespPromise).ok()).toBeTruthy();
    expect((await publishRespPromise).ok()).toBeTruthy();

    // Publish should land users in Monitor.
    await expect(page.locator('#monitor')).toBeVisible();
    await expect
      .poll(async () => String(await page.locator('#bountiesTbody').textContent()), { timeout: 10_000 })
      .toContain(title);
  } finally {
    await originServer.close();
  }
});
