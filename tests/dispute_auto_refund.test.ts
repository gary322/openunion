import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { buildServer } from '../src/server.js';
import { pool } from '../src/db/client.js';
import { resetStore } from '../src/store.js';
import { claimOutboxBatch, markOutboxSent } from '../workers/outbox-lib.js';
import { handleDisputeAutoRefundRequested } from '../workers/handlers.js';

const ADMIN_TOKEN = 'pw_adm_internal';
const VERIFIER_TOKEN = 'pw_vf_internal';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Disputes: auto refund after hold window', () => {
  beforeEach(async () => {
    await resetStore();
  });

  it('opens a dispute, blocks payout, and auto-refunds (minus Proofwork fee) after hold_until', async () => {
    const app = buildServer();
    await app.ready();

    // Create org + buyer token.
    const reg = await request(app.server).post('/api/org/register').send({
      orgName: 'Acme',
      email: 'acme@example.com',
      password: 'password123',
      apiKeyName: 'default',
    });
    expect(reg.status).toBe(200);
    const orgId = reg.body.orgId as string;
    const buyerToken = reg.body.token as string;

    // Seed a verified origin for the org (skip real DNS/HTTP verification in tests).
    await pool.query(
      `
      INSERT INTO origins(id, org_id, origin, status, method, token, verified_at, failure_reason, created_at)
      VALUES ($1,$2,$3,'verified','dns_txt','seed',now(),NULL,now())
      `,
      ['origin_test_1', orgId, 'https://example.com']
    );

    // Fund billing account so publish can reserve budget.
    const topup = await request(app.server)
      .post(`/api/admin/billing/orgs/${encodeURIComponent(orgId)}/topup`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ amountCents: 50_000 });
    expect(topup.status).toBe(200);

    // Create bounty with a short dispute window so the test runs fast.
    const create = await request(app.server)
      .post('/api/bounties')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({
        title: 'Dispute test bounty',
        description: 'test',
        allowedOrigins: ['https://example.com'],
        payoutCents: 1000,
        requiredProofs: 1,
        fingerprintClassesRequired: ['desktop_us'],
        disputeWindowSec: 2,
        priority: 100,
      });
    expect(create.status).toBe(200);
    const bountyId = create.body.id as string;

    const pub = await request(app.server)
      .post(`/api/bounties/${encodeURIComponent(bountyId)}/publish`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send();
    expect(pub.status).toBe(200);

    // Register worker and take the job.
    const w = await request(app.server).post('/api/workers/register').send({ displayName: 'W', capabilities: { browser: true } });
    expect(w.status).toBe(200);
    const workerToken = w.body.token as string;

    const next = await request(app.server).get('/api/jobs/next').set('Authorization', `Bearer ${workerToken}`);
    expect(next.status).toBe(200);
    expect(next.body.state).toBe('claimable');
    const job = next.body.data.job;
    expect(job.bountyId).toBe(bountyId);

    const claim = await request(app.server)
      .post(`/api/jobs/${encodeURIComponent(job.jobId)}/claim`)
      .set('Authorization', `Bearer ${workerToken}`)
      .send();
    expect(claim.status).toBe(200);

    const presign = await request(app.server)
      .post('/api/uploads/presign')
      .set('Authorization', `Bearer ${workerToken}`)
      .send({ jobId: job.jobId, files: [{ filename: 'shot.png', contentType: 'image/png' }] });
    expect(presign.status).toBe(200);

    const upload = presign.body.uploads[0];
    const uploadPath = new URL(upload.url).pathname;
    const uploadRes = await request(app.server)
      .put(uploadPath)
      .set('Authorization', `Bearer ${workerToken}`)
      .set(upload.headers || {})
      .send(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    expect(uploadRes.status).toBe(200);

    const artifact = {
      kind: 'screenshot',
      label: 'proof',
      sha256: 'abcd1234',
      url: presign.body.uploads[0].finalUrl,
    };

    const manifest = {
      manifestVersion: '1.0',
      jobId: job.jobId,
      bountyId: job.bountyId,
      worker: { workerId: w.body.workerId, skillVersion: '1.0.0', fingerprint: { fingerprintClass: job.environment.fingerprintClass } },
      result: { outcome: 'failure', severity: 'high', expected: 'x', observed: 'y', reproConfidence: 'high' },
      reproSteps: ['1'],
      artifacts: [artifact],
    };

    const submit = await request(app.server)
      .post(`/api/jobs/${encodeURIComponent(job.jobId)}/submit`)
      .set('Authorization', `Bearer ${workerToken}`)
      .send({ manifest, artifactIndex: [artifact] });
    expect(submit.status).toBe(200);
    const submissionId = submit.body.data.submission.id as string;

    const claimVer = await request(app.server)
      .post('/api/verifier/claim')
      .set('Authorization', `Bearer ${VERIFIER_TOKEN}`)
      .send({
        submissionId,
        attemptNo: 1,
        messageId: 'msg1',
        idempotencyKey: 'idem1',
        verifierInstanceId: 'verifier-1',
        claimTtlSec: 600,
      });
    expect(claimVer.status).toBe(200);

    const verdict = await request(app.server)
      .post('/api/verifier/verdict')
      .set('Authorization', `Bearer ${VERIFIER_TOKEN}`)
      .send({
        verificationId: claimVer.body.verificationId,
        claimToken: claimVer.body.claimToken,
        submissionId,
        jobId: job.jobId,
        attemptNo: 1,
        verdict: 'pass',
        reason: 'ok',
        scorecard: { R: 1, E: 1, A: 1, N: 1, T: 1, qualityScore: 100 },
        evidenceArtifacts: [artifact],
      });
    expect(verdict.status).toBe(200);

    // Find payout for the org.
    const payouts = await request(app.server).get('/api/org/payouts').set('Authorization', `Bearer ${buyerToken}`);
    expect(payouts.status).toBe(200);
    expect(payouts.body.payouts.length).toBe(1);
    const payoutId = payouts.body.payouts[0].id as string;

    // Open dispute.
    const disputeOpen = await request(app.server)
      .post('/api/org/disputes')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ payoutId, reason: 'bad' });
    expect(disputeOpen.status).toBe(200);
    expect(disputeOpen.body.dispute.status).toBe('open');
    const disputeId = disputeOpen.body.dispute.id as string;

    // Payout is blocked and payout.requested outbox is stopped.
    const payoutRow = await pool.query<{ blocked_reason: string | null; status: string }>(
      `SELECT blocked_reason, status FROM payouts WHERE id=$1`,
      [payoutId]
    );
    expect(payoutRow.rows[0].blocked_reason).toBe('dispute_open');
    expect(payoutRow.rows[0].status).toBe('pending');

    const obPayout = await pool.query<{ status: string }>(
      `SELECT status FROM outbox_events WHERE topic='payout.requested' AND idempotency_key=$1`,
      [`payout:${payoutId}`]
    );
    expect(obPayout.rows[0]?.status).toBe('sent');

    const obRefund = await pool.query<{ status: string; topic: string }>(
      `SELECT status, topic FROM outbox_events WHERE topic='dispute.auto_refund.requested' AND idempotency_key=$1`,
      [`dispute:auto_refund:${disputeId}`]
    );
    expect(obRefund.rows[0]?.status).toBe('pending');

    // Wait for hold window to pass and process the auto-refund outbox event.
    await sleep(2200);
    const batch = await claimOutboxBatch({ topics: ['dispute.auto_refund.requested'], workerId: 'test-runner', limit: 10 });
    expect(batch.length).toBe(1);
    await handleDisputeAutoRefundRequested(batch[0].payload);
    await markOutboxSent(batch[0].id);

    const payoutAfter = await pool.query<{ status: string; blocked_reason: string | null; amount_cents: number; proofwork_fee_cents: number | null }>(
      `SELECT status, blocked_reason, amount_cents, proofwork_fee_cents FROM payouts WHERE id=$1`,
      [payoutId]
    );
    expect(payoutAfter.rows[0].status).toBe('refunded');
    expect(payoutAfter.rows[0].blocked_reason).toBe('dispute_refund');

    const disputeAfter = await pool.query<{ status: string; resolution: string | null }>(
      `SELECT status, resolution FROM disputes WHERE id=$1`,
      [disputeId]
    );
    expect(disputeAfter.rows[0].status).toBe('resolved');
    expect(disputeAfter.rows[0].resolution).toBe('refund');

    // Refund credited buyer balance for gross - Proofwork fee.
    const acct = await pool.query<{ balance_cents: number }>(
      `SELECT balance_cents FROM billing_accounts WHERE org_id=$1`,
      [orgId]
    );
    const proofworkFee = Number(payoutAfter.rows[0].proofwork_fee_cents ?? 0);
    const expectedRefund = 1000 - proofworkFee;
    // Publish reserved 1000; refund adds expectedRefund back, so net delta is -proofworkFee.
    expect(acct.rows[0].balance_cents).toBe(50_000 - 1000 + expectedRefund);
  });
});

