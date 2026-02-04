import { test, expect } from '@playwright/test';
import http from 'http';

test('org can register an app and use the dynamic app page to create+publish', async ({ page }, testInfo) => {
  test.setTimeout(90_000);

  const baseURL = String(testInfo.project.use.baseURL ?? 'http://localhost:3111').replace(/\/$/, '');

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

    // Add + verify origin via http_file.
    await page.fill('#originUrl', origin);
    await page.fill('#originMethod', 'http_file');

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
    const slug = `e2e-${Date.now()}`;
    const taskType = `e2e_task_${Date.now()}`;
    const name = `E2E App ${Date.now()}`;
    const defaultDescriptor = {
      schema_version: 'v1',
      type: taskType,
      capability_tags: ['http', 'llm_summarize'],
      input_spec: { query: 'hello' },
      output_spec: { required_artifacts: [{ kind: 'log', label: 'report_summary' }] },
      freshness_sla_sec: 3600,
    };

    await page.fill('#appSlug', slug);
    await page.fill('#appTaskType', taskType);
    await page.fill('#appName', name);
    await page.fill('#appDashboardUrl', ''); // force dynamic /apps/app/:slug
    await page.fill('#appDefaultDescriptor', JSON.stringify(defaultDescriptor, null, 2));

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

    // Set API base to the current server (the template defaults to localhost:3000).
    await page.fill('#apiBase', baseURL);
    await page.fill('#buyerToken', buyerToken);
    await page.fill('#origins', origin);
    await page.fill('#payout', '1200');
    await page.fill('#title', `Dynamic app bounty ${Date.now()}`);
    await page.fill('#description', 'E2E dynamic app bounty');

    // Ensure descriptor is present and matches our taskType.
    await expect(page.locator('#descriptor')).toHaveValue(new RegExp(`"type"\\s*:\\s*"${taskType}"`));

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

    // After publish, the page refreshes the bounties list; assert our ID appears.
    await expect
      .poll(async () => String(await page.locator('#bounties').textContent()), { timeout: 10_000 })
      .toContain(bountyId);
  } finally {
    await new Promise<void>((resolve) => originServer.close(() => resolve()));
  }
});
