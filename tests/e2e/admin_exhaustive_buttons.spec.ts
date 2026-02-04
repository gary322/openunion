import { test, expect } from '@playwright/test';

const ADMIN_TOKEN = 'pw_adm_internal';
const VERIFIER_TOKEN = 'pw_vf_internal';

async function createBuyerToken(request: any): Promise<string> {
  const apiKey = await request.post('/api/org/api-keys', {
    data: { email: 'buyer@example.com', password: 'password', name: `e2e-${Date.now()}` },
  });
  expect(apiKey.ok()).toBeTruthy();
  const apiKeyJson = (await apiKey.json()) as any;
  const buyerToken = String(apiKeyJson?.token ?? '');
  expect(buyerToken).toMatch(/^pw_bu_/);
  return buyerToken;
}

async function registerWorker(request: any): Promise<{ workerId: string; token: string }> {
  const w = await request.post('/api/workers/register', { data: { displayName: `E2E worker ${Date.now()}`, capabilities: { browser: true } } });
  expect(w.ok()).toBeTruthy();
  const wJson = (await w.json()) as any;
  const token = String(wJson?.token ?? '');
  const workerId = String(wJson?.workerId ?? '');
  expect(token).toMatch(/^pw_wk_/);
  expect(workerId).toBeTruthy();
  return { workerId, token };
}

async function claimUploadSubmit(request: any, workerToken: string, workerId: string) {
  const workerAuth = { Authorization: `Bearer ${workerToken}` };

  const next = await request.get('/api/jobs/next', { headers: workerAuth });
  expect(next.ok()).toBeTruthy();
  const nextJson = (await next.json()) as any;
  expect(nextJson?.state).toBe('claimable');
  const jobId = String(nextJson?.data?.job?.jobId ?? '');
  const bountyId = String(nextJson?.data?.job?.bountyId ?? '');
  expect(jobId).toBeTruthy();
  expect(bountyId).toBeTruthy();

  const claim = await request.post(`/api/jobs/${encodeURIComponent(jobId)}/claim`, { headers: workerAuth });
  expect(claim.ok()).toBeTruthy();

  const presign = await request.post('/api/uploads/presign', {
    headers: workerAuth,
    data: { jobId, files: [{ filename: 'shot.png', contentType: 'image/png' }] },
  });
  expect(presign.ok()).toBeTruthy();
  const presignJson = (await presign.json()) as any;
  const upload = presignJson?.uploads?.[0];
  const artifactId = String(upload?.artifactId ?? '');
  const uploadUrl = String(upload?.url ?? '');
  const finalUrl = String(upload?.finalUrl ?? '');
  expect(artifactId).toBeTruthy();
  expect(uploadUrl).toContain('/api/uploads/');
  expect(finalUrl).toContain('/api/artifacts/');

  const uploadPath = new URL(uploadUrl).pathname;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const put = await request.put(uploadPath, { headers: { ...workerAuth, ...(upload?.headers ?? {}) }, data: png });
  expect(put.ok()).toBeTruthy();

  const artifact = { kind: 'screenshot', label: 'repro', sha256: 'abcd1234', url: finalUrl };
  const manifest = {
    manifestVersion: '1.0',
    jobId,
    bountyId,
    worker: { workerId, skillVersion: '1.0.0', fingerprint: { fingerprintClass: 'desktop_us' } },
    result: { outcome: 'failure', severity: 'high', expected: 'x', observed: 'y', reproConfidence: 'high' },
    reproSteps: ['1'],
    artifacts: [artifact],
  };

  const submit = await request.post(`/api/jobs/${encodeURIComponent(jobId)}/submit`, {
    headers: workerAuth,
    data: { manifest, artifactIndex: [artifact] },
  });
  expect(submit.ok()).toBeTruthy();
  const submitJson = (await submit.json()) as any;
  const submissionId = String(submitJson?.data?.submission?.id ?? '');
  expect(submissionId).toBeTruthy();

  return { jobId, bountyId, submissionId, artifactId };
}

test('admin UIs: exercise buttons across console, payouts, disputes, apps dashboard, blocked domains, artifacts', async ({ page, request }) => {
  test.setTimeout(180_000);

  const buyerToken = await createBuyerToken(request);
  const buyerAuth = { Authorization: `Bearer ${buyerToken}` };

  // Create a custom app so the apps dashboard moderation buttons have something to toggle.
  const slug = `adm-e2e-${Date.now()}`;
  const taskType = `adm_task_${Date.now()}`;
  const createApp = await request.post('/api/org/apps', {
    headers: buyerAuth,
    data: {
      slug,
      taskType,
      name: `Admin E2E App ${Date.now()}`,
      dashboardUrl: null,
      public: true,
      defaultDescriptor: {
        schema_version: 'v1',
        type: taskType,
        capability_tags: ['http'],
        input_spec: { query: 'hello' },
        output_spec: { required_artifacts: [{ kind: 'log', label: 'report' }] },
        freshness_sla_sec: 3600,
      },
    },
  });
  expect(createApp.ok()).toBeTruthy();
  const appJson = (await createApp.json()) as any;
  const appId = String(appJson?.app?.id ?? '');
  expect(appId).toBeTruthy();

  // Create + publish a bounty with a dispute window (hold) so disputes can be created on its payout.
  const bountyCreate = await request.post('/api/bounties', {
    headers: buyerAuth,
    data: {
      title: `Admin buttons bounty ${Date.now()}`,
      description: 'admin buttons test bounty',
      allowedOrigins: ['https://example.com'], // seeded verified origin
      payoutCents: 5000,
      requiredProofs: 1,
      fingerprintClassesRequired: ['desktop_us', 'mobile_us'],
      disputeWindowSec: 3600,
      priority: 10000,
      taskDescriptor: {
        schema_version: 'v1',
        type: 'github_scan',
        capability_tags: ['http', 'llm_summarize', 'screenshot'],
        input_spec: { query: 'example' },
        output_spec: { required_artifacts: [{ kind: 'screenshot', label: 'repro' }] },
        freshness_sla_sec: 3600,
      },
    },
  });
  expect(bountyCreate.ok()).toBeTruthy();
  const bountyId = String((await bountyCreate.json())?.id ?? '');
  expect(bountyId).toBeTruthy();
  const pub = await request.post(`/api/bounties/${encodeURIComponent(bountyId)}/publish`, { headers: buyerAuth });
  expect(pub.ok()).toBeTruthy();

  // Create two workers and two submissions so we can exercise mark-duplicate + override-verdict on different IDs.
  const w1 = await registerWorker(request);
  const w2 = await registerWorker(request);
  const sub1 = await claimUploadSubmit(request, w1.token, w1.workerId);
  const sub2 = await claimUploadSubmit(request, w2.token, w2.workerId);

  // Create a verification for sub1 so admin can requeue it.
  const verClaim = await request.post('/api/verifier/claim', {
    headers: { Authorization: `Bearer ${VERIFIER_TOKEN}` },
    data: {
      submissionId: sub1.submissionId,
      attemptNo: 1,
      messageId: `msg_${Date.now()}`,
      idempotencyKey: `idem_${Date.now()}`,
      verifierInstanceId: 'e2e-verifier',
      claimTtlSec: 600,
    },
  });
  expect(verClaim.ok()).toBeTruthy();
  const verClaimJson = (await verClaim.json()) as any;
  const verificationId = String(verClaimJson?.verificationId ?? '');
  expect(verificationId).toBeTruthy();

  // --- Admin console (index) buttons.
  await page.goto('/admin/index.html');
  await page.fill('#adminToken', ADMIN_TOKEN);
  await page.click('#btnSave');
  await expect(page.locator('#authStatus')).toContainText('token saved');

  await page.fill('#workerId', w1.workerId);
  await page.fill('#durationSec', '1');
  await page.click('#btnRateLimit');
  await expect(page.locator('#workerStatus')).toContainText('ok');

  await page.click('#btnBan');
  await expect(page.locator('#workerStatus')).toContainText('banned');

  await page.fill('#verificationId', verificationId);
  await page.click('#btnRequeue');
  await expect(page.locator('#verStatus')).toContainText('ok');

  await page.fill('#submissionId', sub1.submissionId);
  await page.click('#btnMarkDup');
  await expect(page.locator('#subStatus')).toContainText('ok');

  await page.fill('#submissionId', sub2.submissionId);
  await page.selectOption('#verdict', 'pass');
  await page.fill('#qualityScore', '100');
  await page.click('#btnOverride');
  await expect(page.locator('#subStatus')).toContainText('ok');

  // Find the payout created by the override.
  const payouts = await request.get('/api/org/payouts?page=1&limit=50', { headers: buyerAuth });
  expect(payouts.ok()).toBeTruthy();
  const payoutsJson = (await payouts.json()) as any;
  const row = (payoutsJson?.payouts ?? []).find((p: any) => String(p?.submissionId ?? '') === sub2.submissionId);
  // Payout list rows use `id` as the payout identifier.
  const payoutId = String(row?.id ?? '');
  expect(payoutId).toBeTruthy();

  // --- Admin payouts page: save token, list, retry.
  await page.goto('/admin/payouts.html');
  await page.fill('#adminToken', ADMIN_TOKEN);
  await page.click('#btnSave');
  await expect(page.locator('#authStatus')).toContainText('token saved');

  await page.click('#btnList');
  await expect(page.locator('#listStatus')).toContainText('ok');
  await expect(page.locator('#out')).toContainText(payoutId);

  await page.fill('#payoutId', payoutId);
  const retryRespPromise = page.waitForResponse(
    (r) => r.url().includes(`/api/admin/payouts/${encodeURIComponent(payoutId)}/retry`) && r.request().method() === 'POST'
  );
  await page.click('#btnRetry');
  const retryResp = await retryRespPromise;
  expect(retryResp.ok()).toBeTruthy();
  await expect(page.locator('#retryStatus')).toContainText('ok');

  // Create a dispute for this held payout so the admin disputes list shows a real row.
  const disputeCreate = await request.post('/api/org/disputes', {
    headers: buyerAuth,
    data: { payoutId, reason: 'e2e dispute' },
  });
  expect(disputeCreate.ok()).toBeTruthy();
  const disputeJson = (await disputeCreate.json()) as any;
  const disputeId = String(disputeJson?.dispute?.id ?? '');
  expect(disputeId).toBeTruthy();

  // --- Admin disputes page: save token, list.
  await page.goto('/admin/disputes.html');
  await page.fill('#adminToken', ADMIN_TOKEN);
  await page.click('#btnSave');
  await expect(page.locator('#authStatus')).toContainText('token saved');
  await page.click('#btnList');
  await expect(page.locator('#listStatus')).toContainText('ok');
  await expect(page.locator('#out')).toContainText(disputeId);

  // --- Admin apps dashboard: toggle an app status (disable → enable).
  await page.goto('/admin/apps.html');
  await page.fill('#adminToken', ADMIN_TOKEN);
  await page.click('#btnSave');
  await page.click('#btnRefresh');
  await expect(page.locator('#status')).toContainText('updated');

  const toggleBtn = page.locator(`button[data-app-id="${appId}"]`);
  await expect(toggleBtn).toBeVisible();
  await toggleBtn.click();
  const appRow = page.locator('#appsList tr').filter({ hasText: appId });
  await expect.poll(async () => await appRow.textContent()).toContain('disabled');

  // Enable again.
  await page.locator(`button[data-app-id="${appId}"]`).click();
  await expect.poll(async () => await appRow.textContent()).toContain('active');

  // --- Blocked domains: upsert → list → delete.
  const badDomain = `evil-${Date.now()}.example`;
  await page.goto('/admin/blocked-domains.html');
  await page.fill('#adminToken', ADMIN_TOKEN);
  await page.click('#btnSave');
  await expect(page.locator('#authStatus')).toContainText('saved');

  await page.fill('#domain', badDomain);
  await page.fill('#reason', 'e2e');
  await page.click('#btnUpsert');
  await expect(page.locator('#upsertStatus')).toContainText('saved');

  await page.click('#btnList');
  await expect(page.locator('#listStatus')).toContainText('ok');
  await expect(page.locator('#rows')).toContainText(badDomain);

  const delBtn = page.locator('#rows tr', { hasText: badDomain }).locator('button[data-del]');
  await delBtn.click();
  await expect.poll(async () => String(await page.locator('#out').textContent())).not.toContain(badDomain);

  // --- Artifacts: get → quarantine → delete (break-glass).
  await page.goto('/admin/artifacts.html');
  await page.fill('#adminToken', ADMIN_TOKEN);
  await page.click('#btnSave');
  await expect(page.locator('#authStatus')).toContainText('saved');

  await page.fill('#artifactId', sub1.artifactId);
  await page.click('#btnGet');
  await expect(page.locator('#getStatus')).toContainText('ok');

  await page.fill('#reason', 'e2e quarantine');
  await page.click('#btnQuarantine');
  await expect(page.locator('#qStatus')).toContainText('quarantined');

  await page.click('#btnDelete');
  await expect(page.locator('#delStatus')).toContainText('deleted');
});
