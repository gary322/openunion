import { test, expect } from '@playwright/test';
import { startHttpFileOriginServer } from './helpers.js';

test('descriptor builder: validate and create a bounty', async ({ page, request }, testInfo) => {
  const baseURL = String(testInfo.project.use.baseURL ?? 'http://localhost:3111').replace(/\/$/, '');

  // Create a buyer API key for the seeded demo user (no session required).
  const apiKey = await request.post('/api/org/api-keys', {
    data: { email: 'buyer@example.com', password: 'password', name: `e2e-${Date.now()}` },
  });
  expect(apiKey.ok()).toBeTruthy();
  const apiKeyJson = (await apiKey.json()) as any;
  const buyerToken = String(apiKeyJson?.token ?? '');
  expect(buyerToken).toMatch(/^pw_bu_/);

  const originSrv = await startHttpFileOriginServer();
  try {
    const buyerAuth = { Authorization: `Bearer ${buyerToken}` };

    // Register an app/task type so the descriptor builder can publish a bounty.
    const taskType = `descriptor_builder_task_${Date.now()}`;
    const slug = `descriptor-builder-${Date.now()}`;
    const appResp = await request.post('/api/org/apps', {
      headers: buyerAuth,
      data: { slug, taskType, name: `Descriptor Builder App ${Date.now()}`, public: false },
    });
    expect(appResp.ok()).toBeTruthy();

    // Create + verify an origin so the bounty create endpoint accepts allowedOrigins.
    const originCreate = await request.post('/api/origins', {
      headers: buyerAuth,
      data: { origin: originSrv.origin, method: 'http_file' },
    });
    expect(originCreate.ok()).toBeTruthy();
    const originCreateJson = (await originCreate.json()) as any;
    const originId = String(originCreateJson?.origin?.id ?? '');
    const verifyToken = String(originCreateJson?.origin?.token ?? originCreateJson?.verification?.token ?? '');
    expect(originId).toBeTruthy();
    expect(verifyToken).toMatch(/^pw_verify_/);
    originSrv.setVerifyToken(verifyToken);

    const originCheck = await request.post(`/api/origins/${encodeURIComponent(originId)}/check`, { headers: buyerAuth });
    expect(originCheck.ok()).toBeTruthy();

    await page.goto('/admin/descriptor-builder.html');

    await page.fill('#token', buyerToken);
    await page.fill('#base', baseURL);
    await page.fill('#title', `Descriptor builder bounty ${Date.now()}`);
    await page.fill('#description', 'Created from descriptor builder E2E');
    await page.fill('#taskType', taskType);
    await page.fill('#origins', originSrv.origin);

    // Must select at least one capability tag in the multi-select list.
    await page.selectOption('#caps', ['http', 'llm_summarize']);

    const createRespPromise = page.waitForResponse((r) => r.url().endsWith('/api/bounties') && r.request().method() === 'POST');
    await page.click('#build');
    const resp = await createRespPromise;
    expect(resp.ok()).toBeTruthy();

    await expect(page.locator('#error')).toContainText('Created bounty');
    await expect(page.locator('#preview')).toContainText('"capability_tags":');
    await expect(page.locator('#preview')).toContainText(taskType);
  } finally {
    await originSrv.close();
  }
});
