import { test, expect } from '@playwright/test';
import http from 'http';
import { fillRequiredAppForm, openDetails } from './helpers';

test('create + publish via a vertical app page (github)', async ({ page }) => {
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

    const buyerToken = await page.locator('#buyerToken').inputValue();
    expect(buyerToken).toMatch(/^pw_bu_/);

    // Add + verify the origin (real verification via http_file).
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

    // Use a vertical app page to create + publish the bounty with task_descriptor.
    await page.goto('/apps/app/github/');
    await expect(page.locator('#hdrTitle')).toContainText('GitHub Scan');

    // If we're already connected via the buyer portal session, no token is required.
    // Otherwise, connect via token for deterministic E2E.
    if (await page.locator('#connectRow').isVisible()) {
      await page.click('#tabToken');
      await page.fill('#buyerToken', buyerToken);
      const originsLoadPromise = page.waitForResponse((r) => r.url().endsWith('/api/origins') && r.request().method() === 'GET');
      await page.click('#btnSaveToken');
      await originsLoadPromise;
    } else {
      await expect(page.locator('#connectedRow')).toBeVisible();
    }

    await expect
      .poll(async () => {
        return await page.evaluate(() => Array.from((document.getElementById('originSelect') as HTMLSelectElement | null)?.options ?? []).map((o) => o.value));
      })
      .toContain(origin);
    await page.selectOption('#originSelect', origin);

    const title = `GitHub E2E ${Date.now()}`;
    await openDetails(page, '#payoutFold');
    await page.fill('#payoutCents', '1200');
    await page.fill('#requiredProofs', '1');
    await page.fill('#title', title);
    await fillRequiredAppForm(page);

    const createRespPromise = page.waitForResponse((r) => r.url().endsWith('/api/bounties') && r.request().method() === 'POST');
    const publishRespPromise = page.waitForResponse((r) => r.url().includes('/api/bounties/') && r.url().endsWith('/publish') && r.request().method() === 'POST');

    await page.click('#btnCreatePublish');

    const createResp = await createRespPromise;
    expect(createResp.ok()).toBeTruthy();
    const createJson = (await createResp.json()) as any;
    expect(String(createJson?.id ?? '')).toBeTruthy();

    const publishResp = await publishRespPromise;
    expect(publishResp.ok()).toBeTruthy();

    // After publish, the app page refreshes the bounties list; assert our title appears.
    await expect
      .poll(async () => String(await page.locator('#bountiesTbody').textContent()), { timeout: 10_000 })
      .toContain(title);
  } finally {
    await new Promise<void>((resolve) => originServer.close(() => resolve()));
  }
});
