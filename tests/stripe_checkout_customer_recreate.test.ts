import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildServer } from '../src/server.js';
import { pool } from '../src/db/client.js';
import { resetStore } from '../src/store.js';

describe('Stripe checkout customer recreation', () => {
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    await resetStore();
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('recreates the Stripe customer when Stripe says it does not exist', async () => {
    const calls: Array<{ url: string; method: string; body: string }> = [];
    globalThis.fetch = (async (url: any, init: any) => {
      const u = String(url);
      const method = String(init?.method ?? 'GET');
      const body = String(init?.body ?? '');
      calls.push({ url: u, method, body });

      if (u === 'https://api.stripe.com/v1/checkout/sessions') {
        if (body.includes('customer=cus_stale')) {
          return new Response(JSON.stringify({ error: { message: "No such customer: 'cus_stale'" } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (body.includes('customer=cus_new')) {
          return new Response(JSON.stringify({ id: 'cs_123', url: 'https://checkout.stripe.com/c/pay/cs_123' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ error: { message: 'unexpected customer id' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (u === 'https://api.stripe.com/v1/customers') {
        return new Response(JSON.stringify({ id: 'cus_new' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      throw new Error(`unexpected_fetch:${u}`);
    }) as any;

    const app = buildServer();
    await app.ready();

    // Seed a stale customer id for the demo org (this simulates switching Stripe accounts/modes).
    // Do this after app.ready() so demo org seeding has occurred.
    await pool.query(`INSERT INTO stripe_customers(id, org_id, stripe_customer_id, created_at)
      VALUES ('sc_1','org_demo','cus_stale',now())
      ON CONFLICT (org_id) DO UPDATE SET stripe_customer_id='cus_stale'`);

    const keyRes = await request(app.server)
      .post('/api/org/api-keys')
      .send({ email: 'buyer@example.com', password: 'password', name: 'stripe-checkout-test' });
    expect(keyRes.status).toBe(200);
    const buyerToken = String(keyRes.body?.token ?? '');
    expect(buyerToken).toMatch(/^pw_bu_/);

    const checkoutRes = await request(app.server)
      .post('/api/billing/topups/checkout')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ amountCents: 500, successUrl: 'https://example.com/success', cancelUrl: 'https://example.com/cancel' });

    expect(checkoutRes.status).toBe(200);
    expect(String(checkoutRes.body?.stripeSessionId ?? '')).toBe('cs_123');
    expect(String(checkoutRes.body?.checkoutUrl ?? '')).toContain('checkout.stripe.com');

    const row = await pool.query<{ stripe_customer_id: string }>('SELECT stripe_customer_id FROM stripe_customers WHERE org_id=$1', ['org_demo']);
    expect(row.rows[0].stripe_customer_id).toBe('cus_new');

    // Ensure we tried checkout twice (stale -> recreate -> success).
    const checkoutCalls = calls.filter((c) => c.url === 'https://api.stripe.com/v1/checkout/sessions');
    expect(checkoutCalls.length).toBe(2);
  });
});
