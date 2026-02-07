import { test, expect } from '@playwright/test';
import { fillBuyerDemoLogin, openBuyerApiKeysTab } from './helpers.js';

test('buyer can create, list, and revoke API keys (revoked token is rejected)', async ({ page, request }) => {
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
  const apiKeyId = String(created?.apiKey?.id ?? '');
  const buyerToken = String(created?.token ?? '');
  expect(apiKeyId).toBeTruthy();
  expect(buyerToken).toMatch(/^pw_bu_/);

  await openBuyerApiKeysTab(page);
  const listRespPromise = page.waitForResponse(
    (r) => r.url().endsWith('/api/org/api-keys') && r.request().method() === 'GET'
  );
  await page.click('#btnListKeys');
  const listResp = await listRespPromise;
  expect(listResp.ok()).toBeTruthy();
  const list = (await listResp.json()) as any;
  const apiKeys = Array.isArray(list?.apiKeys) ? list.apiKeys : [];
  expect(apiKeys.length).toBeGreaterThan(0);
  expect(apiKeys.some((k: any) => String(k?.id ?? '') === apiKeyId)).toBeTruthy();

  await openBuyerApiKeysTab(page);
  await page.fill('#revokeKeyId', apiKeyId);
  const revokeRespPromise = page.waitForResponse(
    (r) => r.url().includes(`/api/session/api-keys/${encodeURIComponent(apiKeyId)}/revoke`) && r.request().method() === 'POST'
  );
  await page.click('#btnRevokeKey');
  const revokeResp = await revokeRespPromise;
  expect(revokeResp.ok()).toBeTruthy();
  await expect(page.locator('#keyStatus')).toContainText('revoked');

  // Revoked buyer tokens must be rejected by API auth.
  const denied = await request.get('/api/bounties', { headers: { Authorization: `Bearer ${buyerToken}` } });
  expect(denied.status()).toBe(401);
});
