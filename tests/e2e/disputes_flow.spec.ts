import { test, expect } from '@playwright/test';
import http from 'http';
import { openDetails } from './helpers.js';

const VERIFIER_TOKEN = 'pw_vf_internal';
const ADMIN_TOKEN = 'pw_adm_internal';

test('buyer can open a dispute and admin can resolve (refund) via UI', async ({ page, request }) => {
  test.setTimeout(120_000);

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
    await openDetails(page, '#foldAccess');
    await page.click('#btnLogin');
    await expect(page.locator('#loginStatus')).toContainText('ok');

    const createKeyRespPromise = page.waitForResponse(
      (r) => r.url().endsWith('/api/session/api-keys') && r.request().method() === 'POST'
    );
    await page.click('#btnCreateKey');
    const createKeyResp = await createKeyRespPromise;
    expect(createKeyResp.ok()).toBeTruthy();
    const buyerToken = await page.locator('#buyerToken').inputValue();
    expect(buyerToken).toMatch(/^pw_bu_/);

    // Add + verify origin via http_file.
    await openDetails(page, '#foldOrigins');
    await page.fill('#originUrl', origin);
    await page.selectOption('#originMethod', 'http_file');
    const addOriginRespPromise = page.waitForResponse((r) => r.url().includes('/api/origins') && r.request().method() === 'POST');
    await page.click('#btnAddOrigin');
    const addOriginResp = await addOriginRespPromise;
    expect(addOriginResp.ok()).toBeTruthy();
    const addOriginJson = (await addOriginResp.json()) as any;
    verifyToken = String(addOriginJson?.origin?.token ?? '');
    expect(verifyToken).toMatch(/^pw_verify_/);

    const originRow = page.locator('#originsTbody tr').filter({ hasText: origin }).first();
    await originRow.getByRole('button', { name: 'Check' }).click();
    await expect(page.locator('#originStatus')).toContainText('status=verified');

    // Create + publish a bounty with a short dispute window so we can test dispute flows.
    const auth = { Authorization: `Bearer ${buyerToken}` };
    const bountyCreate = await request.post('/api/bounties', {
      headers: auth,
      data: {
        title: `Dispute UI bounty ${Date.now()}`,
        description: 'dispute ui test',
        allowedOrigins: [origin],
        payoutCents: 1200,
        requiredProofs: 1,
        fingerprintClassesRequired: ['desktop_us'],
        disputeWindowSec: 2,
        priority: 100,
        taskDescriptor: {
          schema_version: 'v1',
          type: 'github_scan', // built-in system app type
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

    // Worker portal: register → next → claim → upload → submit.
    await page.goto('/worker/index.html');
    await page.click('#btnRegister');
    await expect(page.locator('#authStatus')).toContainText('Registered workerId');
    const workerToken = await page.locator('#token').inputValue();
    expect(workerToken).toMatch(/^pw_wk_/);

    await page.click('#btnClaimNext');
    await expect(page.locator('#jobStatus')).toContainText('claimed leaseNonce=');

    // Upload a minimal PNG (scanner is basic in E2E). Use the guided required-outputs flow.
    await expect(page.locator('#requiredOutputs')).toContainText('repro');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const fcPromise = page.waitForEvent('filechooser');
    await page.click('#requiredOutputs button[data-slot="0"]');
    const fc = await fcPromise;
    await fc.setFiles({ name: 'shot.png', mimeType: 'image/png', buffer: png });
    await expect(page.locator('#requiredOutputsStatus')).toContainText('Ready: 1/1');

    await page.fill('#summary', 'Uploaded required artifact(s) and submitted.');

    const submitRespPromise = page.waitForResponse(
      (r) => r.url().includes('/api/jobs/') && r.url().endsWith('/submit') && r.request().method() === 'POST'
    );
    await page.click('#btnSubmit');
    const submitResp = await submitRespPromise;
    expect(submitResp.ok()).toBeTruthy();
    const submitJson = (await submitResp.json()) as any;
    const submissionId = String(submitJson?.data?.submission?.id ?? '');
    const jobId = String(submitJson?.data?.jobStatus?.id ?? submitJson?.data?.jobStatus?.jobId ?? '');
    expect(submissionId).toBeTruthy();
    expect(jobId).toBeTruthy();

    // Drive verification to pass via the verifier API (bypasses the gateway).
    const claim = await request.post('/api/verifier/claim', {
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
    expect(claim.ok()).toBeTruthy();
    const claimJson = (await claim.json()) as any;
    const claimToken = String(claimJson?.claimToken ?? '');
    expect(claimToken).toBeTruthy();

    const verdict = await request.post('/api/verifier/verdict', {
      headers: { Authorization: `Bearer ${VERIFIER_TOKEN}` },
      data: {
        verificationId: claimJson.verificationId,
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

    // Find the payout ID.
    const payouts = await request.get('/api/org/payouts?page=1&limit=50', { headers: auth });
    expect(payouts.ok()).toBeTruthy();
    const payoutsJson = (await payouts.json()) as any;
    const payoutId = String(payoutsJson?.payouts?.[0]?.id ?? '');
    expect(payoutId).toBeTruthy();

    // Buyer UI: open dispute.
    await page.goto('/buyer/index.html');
    await openDetails(page, '#foldAccess');
    await page.fill('#buyerToken', buyerToken);
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

    // Admin UI: resolve dispute as refund (break-glass).
    await page.goto('/admin/disputes.html');
    await page.fill('#adminToken', ADMIN_TOKEN);
    await page.click('#btnSave');
    await expect(page.locator('#authStatus')).toContainText('token saved');

    await page.fill('#disputeId', disputeId);
    await page.selectOption('#resolution', 'refund');
    await page.fill('#notes', 'e2e refund');
    const resolveRespPromise = page.waitForResponse(
      (r) => r.url().includes(`/api/admin/disputes/${encodeURIComponent(disputeId)}/resolve`) && r.request().method() === 'POST'
    );
    await page.click('#btnResolve');
    const resolveResp = await resolveRespPromise;
    expect(resolveResp.ok()).toBeTruthy();
    await expect(page.locator('#resolveStatus')).toContainText('ok');

    // Payout should now be refunded.
    const payoutsAfter = await request.get('/api/org/payouts?page=1&limit=50', { headers: auth });
    expect(payoutsAfter.ok()).toBeTruthy();
    const payoutsAfterJson = (await payoutsAfter.json()) as any;
    const row = (payoutsAfterJson?.payouts ?? []).find((p: any) => String(p?.id ?? '') === payoutId);
    expect(String(row?.status ?? '')).toBe('refunded');
  } finally {
    await new Promise<void>((resolve) => originServer.close(() => resolve()));
  }
});
