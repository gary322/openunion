import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { nanoid } from 'nanoid';
import { buildServer } from '../src/server.js';
import { resetStore, createWorker, addSubmission, addPayout } from '../src/store.js';
import { db } from '../src/db/client.js';

describe('Admin payout mark (break-glass)', () => {
  const ADMIN_TOKEN = 'pw_adm_internal';

  beforeEach(async () => {
    await resetStore();
  });

  it('marks payout status and stops payout outbox execution', async () => {
    const app = buildServer();
    await app.ready();

    const { worker } = await createWorker('w', { browser: true });
    const jobRow: any = await db.selectFrom('jobs').selectAll().limit(1).executeTakeFirstOrThrow();
    const bountyRow: any = await db.selectFrom('bounties').selectAll().where('id', '=', jobRow.bounty_id).executeTakeFirstOrThrow();

    const submissionId = `sub_${nanoid(10)}`;
    await addSubmission({
      id: submissionId,
      jobId: jobRow.id,
      workerId: worker.id,
      manifest: { manifestVersion: '1.0', jobId: jobRow.id, bountyId: bountyRow.id, result: { expected: 'x', observed: 'y' } },
      artifactIndex: [],
      status: 'accepted',
      createdAt: Date.now(),
      payoutStatus: 'pending',
    } as any);

    const payout = await addPayout(submissionId, worker.id, 1000);

    // Simulate a pending payout execution event (what verifier verdict would enqueue).
    await db
      .insertInto('outbox_events')
      .values({
        id: nanoid(12),
        topic: 'payout.requested',
        idempotency_key: `payout:${payout.id}`,
        payload: { payoutId: payout.id, submissionId, workerId: worker.id },
        status: 'pending',
        attempts: 0,
        available_at: new Date(),
        locked_at: null,
        locked_by: null,
        last_error: null,
        created_at: new Date(),
        sent_at: null,
      } as any)
      .execute();

    const mark = await request(app.server)
      .post(`/api/admin/payouts/${encodeURIComponent(payout.id)}/mark`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ status: 'paid', provider: 'manual', providerRef: 'tx_test', reason: 'manual reconciliation' });
    expect(mark.status).toBe(200);

    const payoutRow: any = await db.selectFrom('payouts').selectAll().where('id', '=', payout.id).executeTakeFirstOrThrow();
    expect(payoutRow.status).toBe('paid');
    expect(payoutRow.provider).toBe('manual');
    expect(payoutRow.provider_ref).toBe('tx_test');

    const outboxRow: any = await db
      .selectFrom('outbox_events')
      .select(['status', 'sent_at'])
      .where('topic', '=', 'payout.requested')
      .where('idempotency_key', '=', `payout:${payout.id}`)
      .executeTakeFirstOrThrow();
    expect(outboxRow.status).toBe('sent');
    expect(outboxRow.sent_at).toBeTruthy();

    const subRow: any = await db.selectFrom('submissions').select(['payout_status']).where('id', '=', submissionId).executeTakeFirstOrThrow();
    expect(subRow.payout_status).toBe('paid');
  });
});

