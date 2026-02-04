import { test, expect } from '@playwright/test';

const VERIFIER_TOKEN = 'pw_vf_internal';
const ADMIN_TOKEN = 'pw_adm_internal';

test('admin payouts UI can mark a payout status (break-glass reconciliation)', async ({ page, request }) => {
  test.setTimeout(120_000);

  // Create a buyer API key for the seeded demo user (no session required).
  const apiKey = await request.post('/api/org/api-keys', {
    data: { email: 'buyer@example.com', password: 'password', name: `e2e-${Date.now()}` },
  });
  expect(apiKey.ok()).toBeTruthy();
  const apiKeyJson = (await apiKey.json()) as any;
  const buyerToken = String(apiKeyJson?.token ?? '');
  expect(buyerToken).toMatch(/^pw_bu_/);

  const auth = { Authorization: `Bearer ${buyerToken}` };

  // Create + publish a bounty (uses seeded verified origin https://example.com).
  const bountyCreate = await request.post('/api/bounties', {
    headers: auth,
    data: {
      title: `Admin payout mark bounty ${Date.now()}`,
      description: 'admin payout mark test',
      allowedOrigins: ['https://example.com'],
      payoutCents: 1000,
      requiredProofs: 1,
      fingerprintClassesRequired: ['desktop_us'],
      priority: 100,
      disputeWindowSec: 0,
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

  const pub = await request.post(`/api/bounties/${encodeURIComponent(bountyId)}/publish`, { headers: auth });
  expect(pub.ok()).toBeTruthy();

  // Register worker.
  const w = await request.post('/api/workers/register', { data: { displayName: 'E2E worker', capabilities: { browser: true } } });
  expect(w.ok()).toBeTruthy();
  const wJson = (await w.json()) as any;
  const workerToken = String(wJson?.token ?? '');
  const workerId = String(wJson?.workerId ?? '');
  expect(workerToken).toMatch(/^pw_wk_/);
  expect(workerId).toBeTruthy();

  const workerAuth = { Authorization: `Bearer ${workerToken}` };

  // Claim the job.
  const next = await request.get('/api/jobs/next', { headers: workerAuth });
  expect(next.ok()).toBeTruthy();
  const nextJson = (await next.json()) as any;
  expect(nextJson?.state).toBe('claimable');
  const jobId = String(nextJson?.data?.job?.jobId ?? '');
  expect(jobId).toBeTruthy();

  const claim = await request.post(`/api/jobs/${encodeURIComponent(jobId)}/claim`, { headers: workerAuth });
  expect(claim.ok()).toBeTruthy();

  // Upload one artifact via local presign path.
  const presign = await request.post('/api/uploads/presign', {
    headers: workerAuth,
    data: { jobId, files: [{ filename: 'shot.png', contentType: 'image/png' }] },
  });
  expect(presign.ok()).toBeTruthy();
  const presignJson = (await presign.json()) as any;
  const upload = presignJson?.uploads?.[0];
  const uploadUrl = String(upload?.url ?? '');
  const finalUrl = String(upload?.finalUrl ?? '');
  expect(uploadUrl).toContain('/api/uploads/');
  // finalUrl is the stable download URL (not the presigned upload URL).
  expect(finalUrl).toContain('/api/artifacts/');

  const uploadPath = new URL(uploadUrl).pathname;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const put = await request.put(uploadPath, {
    headers: { ...workerAuth, ...(upload?.headers ?? {}) },
    data: png,
  });
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

  // Pass verification.
  const verClaim = await request.post('/api/verifier/claim', {
    headers: { Authorization: `Bearer ${VERIFIER_TOKEN}` },
    data: {
      submissionId,
      attemptNo: 1,
      messageId: `msg_${Date.now()}`,
      idempotencyKey: `idem_${Date.now()}`,
      verifierInstanceId: 'e2e-verifier',
      claimTtlSec: 600,
    },
  });
  expect(verClaim.ok()).toBeTruthy();
  const verClaimJson = (await verClaim.json()) as any;
  const claimToken = String(verClaimJson?.claimToken ?? '');
  expect(claimToken).toBeTruthy();

  const verdict = await request.post('/api/verifier/verdict', {
    headers: { Authorization: `Bearer ${VERIFIER_TOKEN}` },
    data: {
      verificationId: verClaimJson.verificationId,
      claimToken,
      submissionId,
      jobId,
      attemptNo: 1,
      verdict: 'pass',
      reason: 'ok',
      scorecard: { R: 1, E: 1, A: 1, N: 1, T: 1, qualityScore: 100 },
      evidenceArtifacts: [],
    },
  });
  expect(verdict.ok()).toBeTruthy();

  // Get payout ID for the submission.
  const payouts = await request.get('/api/org/payouts?page=1&limit=50', { headers: auth });
  expect(payouts.ok()).toBeTruthy();
  const payoutsJson = (await payouts.json()) as any;
  const payoutId = String(payoutsJson?.payouts?.[0]?.id ?? '');
  expect(payoutId).toBeTruthy();

  // Admin UI: mark payout failed (break-glass).
  await page.goto('/admin/payouts.html');
  await page.fill('#adminToken', ADMIN_TOKEN);
  await page.click('#btnSave');
  await expect(page.locator('#authStatus')).toContainText('token saved');

  await page.fill('#markPayoutId', payoutId);
  await page.selectOption('#markStatus', 'failed');
  await page.fill('#markReason', 'e2e mark failed');

  const markRespPromise = page.waitForResponse(
    (r) => r.url().includes(`/api/admin/payouts/${encodeURIComponent(payoutId)}/mark`) && r.request().method() === 'POST'
  );
  await page.click('#btnMark');
  const markResp = await markRespPromise;
  expect(markResp.ok()).toBeTruthy();
  await expect(page.locator('#markStatusMsg')).toContainText('ok');

  // Worker payout list should reflect the new status.
  const workerPayouts = await request.get('/api/worker/payouts?page=1&limit=50', { headers: workerAuth });
  expect(workerPayouts.ok()).toBeTruthy();
  const wp = (await workerPayouts.json()) as any;
  const row = (wp?.payouts ?? []).find((p: any) => String(p?.id ?? '') === payoutId);
  expect(String(row?.status ?? '')).toBe('failed');
});
