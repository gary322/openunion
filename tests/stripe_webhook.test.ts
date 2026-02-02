import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createHmac } from 'crypto';
import { buildServer } from '../src/server.js';
import { pool } from '../src/db/client.js';
import { resetStore } from '../src/store.js';

function stripeHeader(secret: string, body: string, t: number) {
  const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${sig}`;
}

describe('Stripe webhook', () => {
  beforeEach(async () => {
    await resetStore();
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
  });

  it('credits billing account once (idempotent by event id)', async () => {
    const app = buildServer();
    await app.ready();

    const orgId = 'org_demo';
    const accountId = `acct_${orgId}`;
    const paymentIntentId = 'pi_test_1';
    // Demo seed may pre-create this account; capture baseline and assert increments.
    await pool.query(
      `INSERT INTO billing_accounts(id, org_id, balance_cents, currency, created_at, updated_at)
       VALUES ($1,$2,0,'usd',now(),now())
       ON CONFLICT (org_id) DO NOTHING`,
      [accountId, orgId]
    );
    await pool.query(
      `INSERT INTO payment_intents(id, account_id, provider, provider_ref, amount_cents, status, created_at, updated_at)
       VALUES ($1,$2,'stripe',NULL,500,'pending',now(),now())
       ON CONFLICT (id) DO NOTHING`,
      [paymentIntentId, accountId]
    );

    const bal0 = await pool.query<{ balance_cents: number }>('SELECT balance_cents FROM billing_accounts WHERE id=$1', [accountId]);
    const baseline = bal0.rows[0].balance_cents;

    const event = {
      id: 'evt_test_1',
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: 'cs_test_1',
          payment_status: 'paid',
          amount_total: 500,
          currency: 'usd',
          metadata: { orgId, accountId, paymentIntentId },
        },
      },
    };

    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const hdr = stripeHeader(process.env.STRIPE_WEBHOOK_SECRET!, body, t);

    const res1 = await request(app.server)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', hdr)
      .send(body);
    expect(res1.status).toBe(200);

    const bal1 = await pool.query<{ balance_cents: number }>('SELECT balance_cents FROM billing_accounts WHERE id=$1', [accountId]);
    expect(bal1.rows[0].balance_cents).toBe(baseline + 500);
    const ev1 = await pool.query('SELECT id FROM billing_events WHERE id=$1', [`stripe_evt_${event.id}`]);
    expect(ev1.rowCount).toBe(1);

    // Same event again should not double-apply.
    const res2 = await request(app.server)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', hdr)
      .send(body);
    expect(res2.status).toBe(200);

    const bal2 = await pool.query<{ balance_cents: number }>('SELECT balance_cents FROM billing_accounts WHERE id=$1', [accountId]);
    expect(bal2.rows[0].balance_cents).toBe(baseline + 500);
  });

  it('rejects bad signatures', async () => {
    const app = buildServer();
    await app.ready();

    const body = JSON.stringify({ id: 'evt_bad', type: 'ping', created: Math.floor(Date.now() / 1000), data: { object: {} } });
    const hdr = `t=${Math.floor(Date.now() / 1000)},v1=deadbeef`;

    const res = await request(app.server)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', hdr)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('stripe_signature_mismatch');
  });
});

