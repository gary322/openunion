import { test, expect } from '@playwright/test';
import { Wallet } from 'ethers';
import { startHttpFileOriginServer } from './helpers.js';

test('buyer portal: exercise remaining buttons (fee get, quotas, origins list/revoke, bounties list, org apps list, register)', async ({ page, request }) => {
  test.setTimeout(120_000);

  const originSrv = await startHttpFileOriginServer();

  try {
    await page.goto('/buyer/index.html');
    await page.click('#btnLogin');
    await expect(page.locator('#loginStatus')).toContainText('ok');

    // Mint a buyer token via session (CSRF-protected).
    await page.click('#btnCreateKey');
    await expect(page.locator('#keyStatus')).toContainText('token created');
    const buyerToken = await page.locator('#buyerToken').inputValue();
    expect(buyerToken).toMatch(/^pw_bu_/);

    // Save token button should persist token in localStorage.
    await page.click('#btnSaveToken');
    await expect(page.locator('#keyStatus')).toContainText('token saved');
    await page.reload();
    await expect(page.locator('#buyerToken')).toHaveValue(buyerToken);

    // Platform fee: get → set → get; then reset to 0 to avoid cross-test drift.
    await page.click('#btnGetPlatformFee');
    await expect(page.locator('#pfStatus')).toContainText('ok');

    const feeWallet = Wallet.createRandom().address;
    await page.fill('#pfBps', '123');
    await page.fill('#pfWallet', feeWallet);
    await page.click('#btnSetPlatformFee');
    await expect(page.locator('#pfStatus')).toContainText('saved');

    await page.click('#btnGetPlatformFee');
    await expect(page.locator('#pfBps')).toHaveValue('123');
    await expect(page.locator('#pfWallet')).toHaveValue(feeWallet);

    // Reset platform fee to 0 via API to avoid UI-state flakiness across long pages.
    const resetPf = await request.put('/api/org/platform-fee', {
      headers: { Authorization: `Bearer ${buyerToken}` },
      data: { platformFeeBps: 0, platformFeeWalletAddress: null },
    });
    expect(resetPf.ok()).toBeTruthy();

    // Quotas: get → set → get; then reset to nulls to avoid cross-test drift.
    await page.click('#btnGetQuotas');
    await expect(page.locator('#quotaStatus')).toContainText('ok');

    await page.fill('#quotaDailySpend', '999999999');
    await page.fill('#quotaMonthlySpend', '999999999');
    await page.fill('#quotaMaxOpenJobs', '999999');
    await page.click('#btnSetQuotas');
    await expect(page.locator('#quotaStatus')).toContainText('saved');

    await page.click('#btnGetQuotas');
    await expect(page.locator('#quotaDailySpend')).toHaveValue('999999999');
    await expect(page.locator('#quotaMonthlySpend')).toHaveValue('999999999');
    await expect(page.locator('#quotaMaxOpenJobs')).toHaveValue('999999');

    // Reset quotas to nulls via API to avoid cross-test drift.
    const resetQuotas = await request.put('/api/org/quotas', {
      headers: { Authorization: `Bearer ${buyerToken}` },
      data: { dailySpendLimitCents: null, monthlySpendLimitCents: null, maxOpenJobs: null },
    });
    expect(resetQuotas.ok()).toBeTruthy();

    await page.click('#btnGetQuotas');
    await expect(page.locator('#quotaDailySpend')).toHaveValue('');
    await expect(page.locator('#quotaMonthlySpend')).toHaveValue('');
    await expect(page.locator('#quotaMaxOpenJobs')).toHaveValue('');

    // Origins: add → check → list → revoke → list.
    await page.fill('#originUrl', originSrv.origin);
    await page.fill('#originMethod', 'http_file');

    const addOriginRespPromise = page.waitForResponse((r) => r.url().includes('/api/origins') && r.request().method() === 'POST');
    await page.click('#btnAddOrigin');
    const addOriginResp = await addOriginRespPromise;
    expect(addOriginResp.ok()).toBeTruthy();
    const addOriginJson = (await addOriginResp.json()) as any;
    const originId = String(addOriginJson?.origin?.id ?? '');
    const verifyToken = String(addOriginJson?.origin?.token ?? '');
    expect(originId).toBeTruthy();
    expect(verifyToken).toMatch(/^pw_verify_/);
    originSrv.setVerifyToken(verifyToken);

    await page.fill('#originId', originId);
    await page.click('#btnCheckOrigin');
    await expect(page.locator('#originStatus')).toContainText('status=verified');

    await page.click('#btnListOrigins');
    await expect(page.locator('#originStatus')).toContainText('ok');
    await expect(page.locator('#originOut')).toContainText(originId);

    // Bounties: create → list → publish (publish requires a verified origin).
    await page.fill('#bTitle', `Buyer buttons bounty ${Date.now()}`);
    await page.fill('#bDesc', 'buyer buttons test');
    await page.fill('#bOrigins', originSrv.origin);
    await page.fill('#bPayout', '1200');
    await page.fill('#bFps', 'desktop_us');
    await page.click('#btnCreateBounty');
    await expect(page.locator('#bountyStatus')).toContainText('created bounty');
    const bountyId = await page.locator('#bountyId').inputValue();
    expect(bountyId).toBeTruthy();

    await page.click('#btnListBounties');
    await expect(page.locator('#bountyStatus')).toContainText('ok');
    await expect(page.locator('#bountyOut')).toContainText(bountyId);

    await page.click('#btnPublish');
    await expect(page.locator('#bountyStatus')).toContainText('published');

    // Revoke origin after publish (still must work and show revoked in list).
    await page.click('#btnRevokeOrigin');
    await expect(page.locator('#originStatus')).toContainText('status=revoked');

    await page.click('#btnListOrigins');
    await expect(page.locator('#originOut')).toContainText(originId);

    // Org apps: create → list.
    const slug = `buyer-btns-${Date.now()}`;
    const taskType = `buyer_btns_task_${Date.now()}`;
    await page.fill('#appSlug', slug);
    await page.fill('#appTaskType', taskType);
    await page.fill('#appName', `Buyer Buttons App ${Date.now()}`);
    await page.fill('#appDashboardUrl', '');
    // Default descriptor is behind a progressive-disclosure <details>.
    await page.locator('details:has(#appDefaultDescriptor)').evaluate((d: any) => (d.open = true));
    await page.fill(
      '#appDefaultDescriptor',
      JSON.stringify(
        {
          schema_version: 'v1',
          type: taskType,
          capability_tags: ['http'],
          input_spec: { query: 'hello' },
          output_spec: { required_artifacts: [{ kind: 'log', label: 'report' }] },
          freshness_sla_sec: 3600,
        },
        null,
        2
      )
    );
    await page.click('#btnCreateOrgApp');
    await expect(page.locator('#appsStatus')).toContainText('created app');

    await page.click('#btnListOrgApps');
    await expect(page.locator('#appsStatus')).toContainText('ok');
    await expect(page.locator('#appsOut')).toContainText(slug);

    // Finally, ensure the "Register" flow works (unique email).
    const email = `e2e+${Date.now()}@example.com`;
    await page.fill('#regOrgName', `E2E Org ${Date.now()}`);
    await page.fill('#regApiKeyName', 'default');
    await page.fill('#regEmail', email);
    await page.fill('#regPassword', 'password123');
    const regRespPromise = page.waitForResponse((r) => r.url().endsWith('/api/org/register') && r.request().method() === 'POST');
    await page.click('#btnRegister');
    const regResp = await regRespPromise;
    expect(regResp.ok()).toBeTruthy();
    await expect(page.locator('#regStatus')).toContainText('ok orgId=');
    const newToken = await page.locator('#buyerToken').inputValue();
    expect(newToken).toMatch(/^pw_bu_/);
  } finally {
    await originSrv.close();
  }
});
