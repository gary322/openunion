import { test, expect } from '@playwright/test';
import { fillRequiredAppForm, openDetails, startHttpFileOriginServer } from './helpers';

test('buyer onboarding: publish work in-place (no app page required)', async ({ page }) => {
  test.setTimeout(90_000);

  const originServer = await startHttpFileOriginServer();
  try {
    await page.goto('/buyer/onboarding.html');

    // Connect (demo credentials).
    await page.fill('#loginEmail', 'buyer@example.com');
    await page.fill('#loginPassword', 'password');
    await page.click('#btnLogin');
    await expect(page.locator('#connectConnectedRow')).toBeVisible();

    // Verify an origin via http_file.
    await page.click('#navOrigin');
    await page.fill('#originUrl', originServer.origin);
    await page.selectOption('#originMethod', 'http_file');

    const addOriginRespPromise = page.waitForResponse((r) => r.url().includes('/api/origins') && r.request().method() === 'POST');
    await page.click('#btnAddOrigin');
    const addOriginResp = await addOriginRespPromise;
    expect(addOriginResp.ok()).toBeTruthy();
    const addOriginJson = (await addOriginResp.json()) as any;
    originServer.setVerifyToken(String(addOriginJson?.origin?.token ?? ''));

    const originRow = page.locator('#originsTbody tr').filter({ hasText: originServer.origin }).first();
    await originRow.getByRole('button', { name: 'Check' }).click();
    await expect
      .poll(async () => String(await originRow.textContent()), { timeout: 10_000 })
      .toMatch(/verified/i);

    // Create an org app (uses a template so no JSON edits required).
    await page.click('#navApp');
    const appName = `Wizard App ${Date.now()}`;
    await page.fill('#appName', appName);
    await page.getByRole('button', { name: /HTTP fetch/i }).click();

    const createAppRespPromise = page.waitForResponse((r) => r.url().endsWith('/api/org/apps') && r.request().method() === 'POST');
    await page.click('#btnCreateOrgApp');
    const createAppResp = await createAppRespPromise;
    expect(createAppResp.ok()).toBeTruthy();

    // Publish from inside the wizard.
    await page.click('#navPublish');
    await expect(page.locator('#publishApp')).toBeVisible();
    await page.selectOption('#publishApp', { label: appName });

    // Wait for the publish form to render for the selected app (selection triggers an async refresh).
    const publishSlug = await page.locator('#publishApp').inputValue();
    await expect(page.locator('body')).not.toHaveAttribute('data-refreshing', '1');
    await expect(page.locator('#publishForm')).toHaveAttribute('data-rendered-slug', publishSlug);
    await expect(page.locator('#publishPreflight')).toContainText(/Next:|Ready/i);
    await expect(page.locator('#publishForm .pw-field').first()).toBeVisible();
    await fillRequiredAppForm(page, { rootSelector: '#publishForm' });
    await openDetails(page, '#publishSettingsFold');

    // Select the verified origin if multiple options exist.
    if (await page.locator('#publishOriginSelect').isVisible()) {
      await page.selectOption('#publishOriginSelect', originServer.origin);
      await expect(page.locator('#publishOriginSelect')).toHaveValue(originServer.origin);
    } else {
      await expect(page.locator('#publishOriginSingleText')).toContainText(originServer.origin.replace(/^https?:\/\//, ''));
    }

    // Ensure required app inputs remain filled after any final refresh cycles.
    await fillRequiredAppForm(page, { rootSelector: '#publishForm' });
    await expect(page.locator('#publishPreflight')).toContainText(/Ready/i);

    const createBountyRespPromise = page.waitForResponse((r) => r.url().endsWith('/api/bounties') && r.request().method() === 'POST');
    const publishRespPromise = page.waitForResponse(
      (r) => r.url().includes('/api/bounties/') && r.url().endsWith('/publish') && r.request().method() === 'POST'
    );
    await expect(page.locator('#btnPublishNow')).toBeEnabled();
    await page.click('#btnPublishNow');

    expect((await createBountyRespPromise).ok()).toBeTruthy();
    expect((await publishRespPromise).ok()).toBeTruthy();
    await expect(page.locator('#publishResultCard')).toBeVisible();
  } finally {
    await originServer.close();
  }
});
