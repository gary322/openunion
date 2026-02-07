import { test, expect } from '@playwright/test';
import http from 'http';
import { fillBuyerDemoLogin, fillRequiredAppForm, openDetails } from './helpers';

test('org can register an app and use the dynamic app page to create+publish', async ({ page }) => {
  test.setTimeout(90_000);

  // Stand up a deterministic origin that can be verified via http_file.
  let verifyToken = '';
  const originServer = http.createServer((req, res) => {
    if (req.url === '/.well-known/proofwork-verify.txt') {
      if (!verifyToken) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('missing');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(verifyToken);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body><h1>OK</h1></body></html>');
  });
  await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', () => resolve()));
  const port = (originServer.address() as any).port as number;
  const origin = `http://127.0.0.1:${port}`;

  try {
    // Buyer portal: login and mint a buyer API token.
    await page.goto('/buyer/index.html');
    await fillBuyerDemoLogin(page);
    await page.click('#btnLogin');
    await expect(page.locator('#loginStatus')).toContainText('ok');

    await page.click('#btnCreateKey');
    await expect(page.locator('#keyStatus')).toContainText('token created');

    await expect(page.locator('#buyerToken')).toHaveValue(/^pw_bu_/);

    // Add + verify origin via http_file.
    await openDetails(page, '#foldOrigins');
    await page.fill('#originUrl', origin);
    await page.selectOption('#originMethod', 'http_file');

    const addOriginRespPromise = page.waitForResponse((r) => r.url().includes('/api/origins') && r.request().method() === 'POST');
    await page.click('#btnAddOrigin');
    const addOriginResp = await addOriginRespPromise;
    expect(addOriginResp.ok()).toBeTruthy();
    const addOriginJson = (await addOriginResp.json()) as any;
    verifyToken = String(addOriginJson?.origin?.token ?? '');
    expect(verifyToken).toMatch(/^pw_verify_/);

    const originRow = page.locator('#originsTbody tr').filter({ hasText: origin }).first();
    await originRow.getByRole('button', { name: 'Check' }).click();
    await expect(page.locator('#originStatus')).toContainText('status=verified');

    // Create a registry app owned by this org.
    await openDetails(page, '#foldApps');
    const name = `E2E App ${Date.now()}`;
    await page.fill('#appName', name);
    // Use a template to avoid requiring any JSON edits or identifier typing.
    await page.selectOption('#appTemplate', 'generic_http');
    await expect(page.locator('#appDashboardUrl')).toHaveValue(/\/apps\/app\//);

    const createAppRespPromise = page.waitForResponse((r) => r.url().endsWith('/api/org/apps') && r.request().method() === 'POST');
    await page.click('#btnCreateOrgApp');
    const createAppResp = await createAppRespPromise;
    expect(createAppResp.ok()).toBeTruthy();
    await expect(page.locator('#appsStatus')).toContainText('created app');

    // Public apps index should now include this app (public=true by default).
    await page.goto('/apps/');
    await expect(page.getByText(name, { exact: true })).toBeVisible();

    // Open the dynamic app page.
    const card = page.locator('.card').filter({ hasText: name });
    await card.locator('a', { hasText: 'Details' }).click();
    await expect(page.locator('#hdrTitle')).toContainText(name);

    // Token should be auto-detected from localStorage and show the connected state.
    await expect(page.locator('#connectedRow')).toBeVisible();

    // The app page is now a guided 3-step flow; expand the folds we need before interacting
    // with any form fields.
    await openDetails(page, '#foldDescribe');
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
      await expect(page.locator('#originSingleText')).toContainText(`127.0.0.1:${port}`);
    }

    // Create + publish with a unique title.
    const title = `Dynamic app bounty ${Date.now()}`;
    await openDetails(page, '#customPayout');
    await page.fill('#payoutCents', '1200');
    await page.fill('#requiredProofs', '1');
    await page.fill('#title', title);

    const createRespPromise = page.waitForResponse((r) => r.url().endsWith('/api/bounties') && r.request().method() === 'POST');
    const publishRespPromise = page.waitForResponse(
      (r) => r.url().includes('/api/bounties/') && r.url().endsWith('/publish') && r.request().method() === 'POST'
    );
    await page.click('#btnCreatePublish');

    const createResp = await createRespPromise;
    expect(createResp.ok()).toBeTruthy();
    const createJson = (await createResp.json()) as any;
    const bountyId = String(createJson?.id ?? '');
    expect(bountyId).toBeTruthy();

    const publishResp = await publishRespPromise;
    expect(publishResp.ok()).toBeTruthy();

    // After publish, the page refreshes the bounties list; assert our title appears in the table.
    await expect
      .poll(async () => String(await page.locator('#bountiesTbody').textContent()), { timeout: 10_000 })
      .toContain(title);
  } finally {
    await new Promise<void>((resolve) => originServer.close(() => resolve()));
  }
});
