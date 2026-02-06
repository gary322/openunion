import { test, expect } from '@playwright/test';
import http from 'http';
import { fillRequiredAppForm } from './helpers';

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
    await page.click('#btnLogin');
    await expect(page.locator('#loginStatus')).toContainText('ok');

    await page.click('#btnCreateKey');
    await expect(page.locator('#keyStatus')).toContainText('token created');

    expect(await page.locator('#buyerToken').inputValue()).toMatch(/^pw_bu_/);

    // Save token once so app pages can read it from localStorage automatically.
    await page.click('#btnSaveToken');
    await expect(page.locator('#keyStatus')).toContainText('token saved');

    // Add + verify origin via http_file.
    await page.fill('#originUrl', origin);
    await page.selectOption('#originMethod', 'http_file');

    const addOriginRespPromise = page.waitForResponse((r) => r.url().includes('/api/origins') && r.request().method() === 'POST');
    await page.click('#btnAddOrigin');
    const addOriginResp = await addOriginRespPromise;
    expect(addOriginResp.ok()).toBeTruthy();
    const addOriginJson = (await addOriginResp.json()) as any;
    verifyToken = String(addOriginJson?.origin?.token ?? '');
    expect(verifyToken).toMatch(/^pw_verify_/);

    await page.click('#btnCheckOrigin');
    await expect(page.locator('#originStatus')).toContainText('status=verified');

    // Create a registry app owned by this org.
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
    await card.locator('a', { hasText: 'Open' }).click();
    await expect(page.locator('#hdrTitle')).toContainText(name);

    // Token should be auto-detected from localStorage and show the connected state.
    await expect(page.locator('#connectedRow')).toBeVisible();

    // Select the verified origin we just proved via http_file.
    await expect
      .poll(async () => {
        return await page.evaluate(() => Array.from((document.getElementById('originSelect') as HTMLSelectElement | null)?.options ?? []).map((o) => o.value));
      })
      .toContain(origin);
    await page.selectOption('#originSelect', origin);
    await expect(page.locator('#originSelect')).toHaveValue(origin);

    // Create + publish with a unique title.
    const title = `Dynamic app bounty ${Date.now()}`;
    await page.fill('#payoutCents', '1200');
    await page.fill('#requiredProofs', '1');
    await page.fill('#title', title);
    await fillRequiredAppForm(page);

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
