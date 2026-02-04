import { test, expect } from '@playwright/test';

const APP_PATHS: Array<{ path: string; titleIncludes: string }> = [
  { path: '/apps/clips/', titleIncludes: 'Clips' },
  { path: '/apps/marketplace/', titleIncludes: 'Marketplace' },
  { path: '/apps/jobs/', titleIncludes: 'Jobs' },
  { path: '/apps/travel/', titleIncludes: 'Travel' },
  { path: '/apps/research/', titleIncludes: 'Research' },
  { path: '/apps/github/', titleIncludes: 'GitHub' },
  // Dynamic app page for a built-in app.
  { path: '/apps/app/clips/', titleIncludes: 'Clips' },
];

test('apps pages: exercise create draft, create+publish, refresh, load jobs on every app page', async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);

  const baseURL = String(testInfo.project.use.baseURL ?? 'http://localhost:3111').replace(/\/$/, '');

  // Create a buyer API key for the seeded demo user (no session required).
  const apiKey = await request.post('/api/org/api-keys', {
    data: { email: 'buyer@example.com', password: 'password', name: `e2e-${Date.now()}` },
  });
  expect(apiKey.ok()).toBeTruthy();
  const apiKeyJson = (await apiKey.json()) as any;
  const buyerToken = String(apiKeyJson?.token ?? '');
  expect(buyerToken).toMatch(/^pw_bu_/);

  for (const app of APP_PATHS) {
    await page.goto(app.path);
    await expect(page.locator('#hdrTitle')).toContainText(app.titleIncludes);

    // Ensure the app calls the right API base in E2E (template defaults to localhost:3000).
    await page.fill('#apiBase', baseURL);
    await page.fill('#buyerToken', buyerToken);
    await page.fill('#origins', 'https://example.com');
    await page.fill('#payout', '1200');
    await page.fill('#title', `E2E ${app.titleIncludes} ${Date.now()}`);
    await page.fill('#description', `E2E ${app.titleIncludes} bounty`);

    // Refresh should load bounties (might be empty; must not error).
    await page.click('#btnRefresh');
    await expect(page.locator('#bounties')).toContainText('"bounties"');

    // Create draft bounty.
    const createDraftRespPromise = page.waitForResponse((r) => r.url().endsWith('/api/bounties') && r.request().method() === 'POST');
    await page.click('#btnCreate');
    const draftResp = await createDraftRespPromise;
    expect(draftResp.ok()).toBeTruthy();
    const draftJson = (await draftResp.json()) as any;
    const draftBountyId = String(draftJson?.id ?? '');
    expect(draftBountyId).toBeTruthy();
    await expect(page.locator('#bounties')).toContainText(draftBountyId);

    // Create + publish bounty (must generate jobs).
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

    await expect(page.locator('#bounties')).toContainText(bountyId);

    // Load jobs for the published bounty.
    await page.fill('#bountyId', bountyId);
    const jobsRespPromise = page.waitForResponse((r) => r.url().includes(`/api/bounties/${encodeURIComponent(bountyId)}/jobs`) && r.request().method() === 'GET');
    await page.click('#btnJobs');
    const jobsResp = await jobsRespPromise;
    expect(jobsResp.ok()).toBeTruthy();
    await expect(page.locator('#jobs')).toContainText('"jobs"');
  }
});

