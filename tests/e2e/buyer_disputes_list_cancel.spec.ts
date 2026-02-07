import { test, expect } from '@playwright/test';
import { fillBuyerDemoLogin, openBuyerApiKeysTab, openDetails } from './helpers.js';

const VERIFIER_TOKEN = 'pw_vf_internal';

test('buyer disputes: create → list → cancel via UI (during hold window)', async ({ page, request }) => {
  test.setTimeout(120_000);

  // Buyer portal: login and mint a buyer API token.
  await page.goto('/buyer/index.html');
  await fillBuyerDemoLogin(page);
  await page.click('#btnLogin');
  await expect(page.locator('#loginStatus')).toContainText('ok');

  await openBuyerApiKeysTab(page);
  const createKeyRespPromise = page.waitForResponse((r) => r.url().endsWith('/api/session/api-keys') && r.request().method() === 'POST');
  await page.click('#btnCreateKey');
  const createKeyResp = await createKeyRespPromise;
  expect(createKeyResp.ok()).toBeTruthy();

  // waitForResponse resolves when the network completes, not when the UI updates.
  await expect(page.locator('#buyerToken')).toHaveValue(/^pw_bu_/);
  const buyerToken = await page.locator('#buyerToken').inputValue();
  const auth = { Authorization: `Bearer ${buyerToken}` };

  // Create + publish a bounty with a non-zero dispute window so payouts are held (disputable).
  const bountyCreate = await request.post('/api/bounties', {
    headers: auth,
    data: {
      title: `Dispute cancel bounty ${Date.now()}`,
      description: 'buyer disputes list/cancel UI test',
      allowedOrigins: ['https://example.com'], // seeded verified origin
      payoutCents: 1200,
      requiredProofs: 1,
      fingerprintClassesRequired: ['desktop_us'],
      disputeWindowSec: 3600, // 1 hour hold window
      priority: 100,
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

  // Register a worker + claim job.
  const w = await request.post('/api/workers/register', { data: { displayName: 'E2E worker', capabilities: { browser: true } } });
  expect(w.ok()).toBeTruthy();
  const wJson = (await w.json()) as any;
  const workerToken = String(wJson?.token ?? '');
  const workerId = String(wJson?.workerId ?? '');
  expect(workerToken).toMatch(/^pw_wk_/);
  expect(workerId).toBeTruthy();
  const workerAuth = { Authorization: `Bearer ${workerToken}` };

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

  // Pass verification using internal verifier token to create a payout with hold_until.
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

  const payouts = await request.get('/api/org/payouts?page=1&limit=50', { headers: auth });
  expect(payouts.ok()).toBeTruthy();
  const payoutsJson = (await payouts.json()) as any;
  const payoutId = String(payoutsJson?.payouts?.[0]?.id ?? '');
  expect(payoutId).toBeTruthy();

  // Buyer UI: open dispute, then list, then cancel.
  await page.addInitScript((t) => localStorage.setItem('pw_buyer_token', String(t || '')), buyerToken);
  await page.goto('/buyer/index.html#disputes');
  await openDetails(page, '#foldDisputes');
  await page.fill('#disputePayoutId', payoutId);
  await page.fill('#disputeReason', 'Incorrect result');

  const openDisputeRespPromise = page.waitForResponse((r) => r.url().endsWith('/api/org/disputes') && r.request().method() === 'POST');
  await page.click('#btnCreateDispute');
  const openDisputeResp = await openDisputeRespPromise;
  expect(openDisputeResp.ok()).toBeTruthy();

  const dispute = (await openDisputeResp.json()) as any;
  const disputeId = String(dispute?.dispute?.id ?? '');
  expect(disputeId).toBeTruthy();
  await expect(page.locator('#disputeStatus')).toContainText('opened dispute');

  await page.click('#btnListDisputes');
  await expect(page.locator('#disputeStatus')).toContainText('ok');
  await expect(page.locator('#disputeOut')).toContainText(disputeId);

  await page.fill('#cancelDisputeId', disputeId);
  const cancelRespPromise = page.waitForResponse(
    (r) => r.url().includes(`/api/org/disputes/${encodeURIComponent(disputeId)}/cancel`) && r.request().method() === 'POST'
  );
  await page.click('#btnCancelDispute');
  const cancelResp = await cancelRespPromise;
  expect(cancelResp.ok()).toBeTruthy();
  await expect(page.locator('#disputeStatus')).toContainText('cancelled');

  await page.click('#btnListDisputes');
  await expect(page.locator('#disputeOut')).toContainText('"status": "cancelled"');
});
