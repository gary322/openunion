import { test, expect } from '@playwright/test';
import { fillRequiredAppForm, openDetails } from './helpers';

const APPS: Array<{ slug: string; titleIncludes: string }> = [
  { slug: 'clips', titleIncludes: 'Clips' },
  { slug: 'marketplace', titleIncludes: 'Marketplace' },
  { slug: 'jobs', titleIncludes: 'Jobs' },
  { slug: 'travel', titleIncludes: 'Travel' },
  { slug: 'research', titleIncludes: 'Research' },
  { slug: 'github', titleIncludes: 'GitHub' },
];

test('apps pages: exercise create draft, create+publish, refresh, load jobs on every built-in app', async ({ page, request }) => {
  test.setTimeout(210_000);

  // Create a buyer API key for the seeded demo user (no session required).
  const apiKey = await request.post('/api/org/api-keys', {
    data: { email: 'buyer@example.com', password: 'password', name: `e2e-${Date.now()}` },
  });
  expect(apiKey.ok()).toBeTruthy();
  const apiKeyJson = (await apiKey.json()) as any;
  const buyerToken = String(apiKeyJson?.token ?? '');
  expect(buyerToken).toMatch(/^pw_bu_/);

  // App pages read buyer token from localStorage; set it once for the whole test to avoid
  // re-connecting on every app navigation.
  await page.addInitScript(({ token }) => {
    localStorage.setItem('pw_buyer_token', token);
    // Create-draft is developer-oriented and intentionally hidden by default.
    localStorage.setItem('pw_dev_mode', '1');
  }, { token: buyerToken });

  for (const app of APPS) {
    await page.goto(`/apps/app/${app.slug}/`);
    await expect(page.locator('#hdrTitle')).toContainText(app.titleIncludes);

    // Connected state should be visible (token is injected via initScript).
    await expect(page.locator('#connectedRow')).toBeVisible();

    // Wizard: ensure describe controls are expanded so Dev-only template tools are interactable.
    await openDetails(page, '#foldDescribe');

    // Describe: (optional) apply the first template if available.
    const hasTemplates = (await page.locator('#template option').count()) > 1;
    if (hasTemplates) {
      await page.selectOption('#template', { index: 1 });
      await page.click('#btnApplyTemplate');
    }

    // Fill any required friendly-form inputs that templates didn't populate.
    await fillRequiredAppForm(page);

    // Wizard: publish step may be collapsed until the form is complete; expand it for settings access.
    await openDetails(page, '#foldPublish');

    // Most config is intentionally tucked behind a fold so the default workflow stays simple.
    await openDetails(page, '#settingsFold');

    // Publish: choose a verified origin and set payout.
    await expect
      .poll(async () => {
        return await page.evaluate(() => Array.from((document.getElementById('originSelect') as HTMLSelectElement | null)?.options ?? []).map((o) => o.value));
      })
      .toContain('https://example.com');
    if (await page.locator('#originSelect').isVisible()) {
      await page.selectOption('#originSelect', 'https://example.com');
    } else {
      await expect(page.locator('#originSingleText')).toContainText('https://example.com');
    }

    await openDetails(page, '#customPayout');
    await page.fill('#payoutCents', '1200');
    await page.fill('#requiredProofs', '1');

    // Create draft bounty.
    const draftTitle = `E2E ${app.titleIncludes} draft ${Date.now()}`;
    await page.fill('#title', draftTitle);
    const createDraftRespPromise = page.waitForResponse((r) => r.url().endsWith('/api/bounties') && r.request().method() === 'POST');
    await page.click('#btnCreateDraft');
    const draftResp = await createDraftRespPromise;
    expect(draftResp.ok()).toBeTruthy();

    // Creating a bounty should land users in Monitor (low-effort feedback).
    await expect(page.locator('#monitor')).toBeVisible();

    // Monitor table should include the title we just created.
    await expect
      .poll(async () => String(await page.locator('#bountiesTbody').textContent()), { timeout: 10_000 })
      .toContain(draftTitle);

    // Refresh bounties (must not error, even if empty in other cases).
    await page.click('#btnRefreshBounties');
    await expect(page.locator('#monitorStatus')).not.toContainText('Failed');

    // Return to Create work for the next publish.
    await page.locator('.pw-sidenav a[href="#create"]').click();
    await expect(page.locator('#create')).toBeVisible();

    // Create + publish bounty (should create jobs).
    const pubTitle = `E2E ${app.titleIncludes} pub ${Date.now()}`;
    await page.fill('#title', pubTitle);
    const createRespPromise = page.waitForResponse((r) => r.url().endsWith('/api/bounties') && r.request().method() === 'POST');
    const publishRespPromise = page.waitForResponse((r) => r.url().includes('/api/bounties/') && r.url().endsWith('/publish') && r.request().method() === 'POST');
    await page.click('#btnCreatePublish');

    const createResp = await createRespPromise;
    expect(createResp.ok()).toBeTruthy();
    const createJson = (await createResp.json()) as any;
    const bountyId = String(createJson?.id ?? '');
    expect(bountyId).toBeTruthy();

    const publishResp = await publishRespPromise;
    expect(publishResp.ok()).toBeTruthy();

    await expect
      .poll(async () => String(await page.locator('#bountiesTbody').textContent()), { timeout: 10_000 })
      .toContain(pubTitle);

    // Load jobs for the published bounty using the per-row "Jobs" action.
    const row = page.locator('#bountiesTbody tr').filter({ hasText: pubTitle }).first();
    const jobsRespPromise = page.waitForResponse((r) => r.url().includes(`/api/bounties/${encodeURIComponent(bountyId)}/jobs`) && r.request().method() === 'GET');
    await row.getByRole('button', { name: 'Jobs' }).click();
    const jobsResp = await jobsRespPromise;
    expect(jobsResp.ok()).toBeTruthy();

    // Jobs table should populate.
    await expect
      .poll(async () => (await page.locator('#jobsTbody').innerText()).trim().length, { timeout: 10_000 })
      .toBeGreaterThan(0);
  }
});
