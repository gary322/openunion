import { test, expect } from '@playwright/test';
import { fillBuyerDemoLogin, openBuyerApiKeysTab, openDetails } from './helpers.js';

test('buyer can set per-org CORS allowlist and it is enforced', async ({ page, request }) => {
  await page.goto('/buyer/index.html');
  await fillBuyerDemoLogin(page);
  await page.click('#btnLogin');
  await expect(page.locator('#loginStatus')).toContainText('ok');

  await openBuyerApiKeysTab(page);
  const createRespPromise = page.waitForResponse(
    (r) => r.url().endsWith('/api/session/api-keys') && r.request().method() === 'POST'
  );
  await page.click('#btnCreateKey');
  const createResp = await createRespPromise;
  expect(createResp.ok()).toBeTruthy();
  const created = (await createResp.json()) as any;
  const buyerToken = String(created?.token ?? '');
  expect(buyerToken).toMatch(/^pw_bu_/);

  const allowOrigin = `https://ui-${Date.now()}.example.com`;

  await openDetails(page, '#foldCors');
  await page.fill('#corsOrigins', allowOrigin);
  const setRespPromise = page.waitForResponse(
    (r) => r.url().endsWith('/api/org/cors-allow-origins') && r.request().method() === 'PUT'
  );
  await page.click('#btnSetCors');
  const setResp = await setRespPromise;
  expect(setResp.ok()).toBeTruthy();
  await expect(page.locator('#corsStatus')).toContainText('saved');

  await page.click('#btnGetCors');
  await expect(page.locator('#corsOrigins')).toHaveValue(new RegExp(allowOrigin));

  // Allowed Origin should pass for buyer-token calls.
  const ok = await request.get('/api/bounties', {
    headers: { Authorization: `Bearer ${buyerToken}`, Origin: allowOrigin },
  });
  expect(ok.ok()).toBeTruthy();

  // Non-allowlisted Origin must be rejected for buyer tokens.
  const denied = await request.get('/api/bounties', {
    headers: { Authorization: `Bearer ${buyerToken}`, Origin: 'https://evil.example' },
  });
  expect(denied.status()).toBe(403);
});
