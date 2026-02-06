// Remote Stripe top-up smoke test for a deployed Proofwork environment.
//
// This script verifies the buyer funding path:
// - creates a buyer API key
// - creates a Stripe Checkout Session via the API
// - simulates a signed Stripe webhook (checkout.session.completed)
// - asserts billing balance increases
// - (best-effort) creates + publishes + closes a bounty to confirm funds can be used
//
// Usage:
//   BASE_URL=http://... SMOKE_STRIPE_WEBHOOK_SECRET=whsec_... npm run smoke:stripe:remote
//
// Notes:
// - Do not print secrets. This script only prints non-sensitive IDs/URLs.
// - This does *not* attempt to complete an actual Stripe payment; it simulates the webhook so
//   staging can be tested deterministically.

import { createHmac } from 'node:crypto';

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function mustEnv(name: string, fallback?: string): string {
  const v = (process.env[name] ?? fallback ?? '').toString().trim();
  if (!v) throw new Error(`missing_${name}`);
  return v;
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/$/, '');
}

function tsSuffix() {
  return new Date().toISOString().replace(/[:.]/g, '');
}

async function fetchJson(input: {
  baseUrl: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: any;
}): Promise<{ status: number; ok: boolean; headers: Headers; json: any; text: string }> {
  const url = `${input.baseUrl}${input.path}`;
  const resp = await fetch(url, {
    method: input.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(input.headers ?? {}) },
    body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
  });
  const text = await resp.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: resp.status, ok: resp.ok, headers: resp.headers, json, text };
}

function stripeSignatureHeader(input: { webhookSecret: string; rawBody: string; timestampSec: number }) {
  const sig = createHmac('sha256', input.webhookSecret).update(`${input.timestampSec}.${input.rawBody}`).digest('hex');
  return `t=${input.timestampSec},v1=${sig}`;
}

async function ensureBuyerAuth(input: {
  baseUrl: string;
  email: string;
  password: string;
}): Promise<{ buyerToken: string; orgId?: string; email: string; password: string }> {
  // Try existing login first.
  const apiKeyResp = await fetchJson({
    baseUrl: input.baseUrl,
    path: '/api/org/api-keys',
    method: 'POST',
    body: { email: input.email, password: input.password, name: `smoke-stripe-${tsSuffix()}` },
  });
  if (apiKeyResp.ok) {
    const buyerToken = String(apiKeyResp.json?.token ?? '');
    if (!buyerToken) throw new Error('api_key_missing_token');
    return { buyerToken, email: input.email, password: input.password };
  }

  // Fall back to self-serve registration.
  let email = input.email;
  let password = input.password;
  if (email === 'buyer@example.com' && !process.env.SMOKE_BUYER_EMAIL) {
    email = `smoke+${tsSuffix()}@example.com`;
    password = `pw_${tsSuffix()}_demo`;
  }

  const reg = await fetchJson({
    baseUrl: input.baseUrl,
    path: '/api/org/register',
    method: 'POST',
    body: {
      orgName: process.env.SMOKE_ORG_NAME ?? `Smoke Stripe Org ${tsSuffix()}`,
      email,
      password,
      apiKeyName: process.env.SMOKE_API_KEY_NAME ?? 'default',
    },
  });

  if (!reg.ok) {
    // If the email already exists, retry api-key creation (assumes caller provided the correct password).
    const code = String(reg.json?.error?.message ?? '');
    if (reg.status === 409 && code.includes('email_already_registered')) {
      const retry = await fetchJson({
        baseUrl: input.baseUrl,
        path: '/api/org/api-keys',
        method: 'POST',
        body: { email, password, name: `smoke-stripe-${tsSuffix()}` },
      });
      if (!retry.ok) throw new Error(`api_key_create_failed_after_conflict:${retry.status}`);
      const buyerToken = String(retry.json?.token ?? '');
      if (!buyerToken) throw new Error('api_key_missing_token');
      return { buyerToken, email, password };
    }
    throw new Error(`org_register_failed:${reg.status}:${reg.json?.error?.message ?? ''}`);
  }

  const buyerToken = String(reg.json?.token ?? '');
  const orgId = String(reg.json?.orgId ?? '');
  if (!buyerToken) throw new Error('org_register_missing_token');
  return { buyerToken, orgId: orgId || undefined, email, password };
}

async function main() {
  const baseUrl = normalizeBaseUrl(argValue('--base-url') ?? process.env.BASE_URL ?? 'http://localhost:3000');

  const webhookSecret = mustEnv('SMOKE_STRIPE_WEBHOOK_SECRET');
  const email = mustEnv('SMOKE_BUYER_EMAIL', 'buyer@example.com');
  const password = mustEnv('SMOKE_BUYER_PASSWORD', 'password');

  const topupCentsRaw = Number(process.env.SMOKE_TOPUP_CENTS ?? 500);
  const topupCents = Number.isFinite(topupCentsRaw) ? Math.max(100, Math.min(50_000, Math.floor(topupCentsRaw))) : 500;

  const successUrl = String(process.env.SMOKE_SUCCESS_URL ?? 'https://example.com/buyer');
  const cancelUrl = String(process.env.SMOKE_CANCEL_URL ?? successUrl);

  // Health
  const health = await fetchJson({ baseUrl, path: '/health' });
  if (!health.ok) throw new Error(`health_failed:${health.status}`);

  // Buyer token (existing or self-serve register)
  const auth = await ensureBuyerAuth({ baseUrl, email, password });
  const buyerToken = auth.buyerToken;
  const authHeader = { authorization: `Bearer ${buyerToken}` };

  // Balance before
  const acct0 = await fetchJson({ baseUrl, path: '/api/billing/account', headers: authHeader });
  if (!acct0.ok) throw new Error(`billing_account_failed:${acct0.status}`);
  const before = Number(acct0.json?.account?.balance_cents ?? 0);
  const orgId = String(auth.orgId ?? acct0.json?.account?.org_id ?? acct0.json?.account?.orgId ?? '');
  const accountId = String(acct0.json?.account?.id ?? '');
  if (!orgId || !accountId) throw new Error('billing_account_missing_org_or_id');

  // Create checkout session
  const checkout = await fetchJson({
    baseUrl,
    path: '/api/billing/topups/checkout',
    method: 'POST',
    headers: authHeader,
    body: { amountCents: topupCents, successUrl, cancelUrl },
  });
  if (!checkout.ok) throw new Error(`checkout_failed:${checkout.status}:${checkout.text}`);
  const stripeSessionId = String(checkout.json?.stripeSessionId ?? '');
  const paymentIntentId = String(checkout.json?.paymentIntentId ?? '');
  const checkoutUrl = String(checkout.json?.checkoutUrl ?? '');
  if (!stripeSessionId || !paymentIntentId || !checkoutUrl) throw new Error('checkout_invalid_response');

  // Simulate Stripe webhook: checkout.session.completed
  const evt = {
    id: `evt_smoke_${tsSuffix()}`,
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: stripeSessionId,
        payment_status: 'paid',
        amount_total: topupCents,
        currency: 'usd',
        metadata: { orgId, accountId, paymentIntentId },
      },
    },
  };
  const rawBody = JSON.stringify(evt);
  const ts = Math.floor(Date.now() / 1000);
  const sigHeader = stripeSignatureHeader({ webhookSecret, rawBody, timestampSec: ts });

  const webhook = await fetch(`${baseUrl}/api/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sigHeader },
    body: rawBody,
  });
  const webhookText = await webhook.text();
  if (!webhook.ok) throw new Error(`webhook_failed:${webhook.status}:${webhookText}`);

  // Balance after
  const acct1 = await fetchJson({ baseUrl, path: '/api/billing/account', headers: authHeader });
  if (!acct1.ok) throw new Error(`billing_account_failed_after:${acct1.status}`);
  const after = Number(acct1.json?.account?.balance_cents ?? 0);
  const delta = after - before;
  if (delta !== topupCents) throw new Error(`unexpected_balance_delta:${delta} (expected ${topupCents})`);

  console.log(`[smoke_stripe] base_url=${baseUrl}`);
  console.log(`[smoke_stripe] topup_cents=${topupCents} before=${before} after=${after}`);
  console.log(`[smoke_stripe] stripe_session_id=${stripeSessionId}`);
  console.log(`[smoke_stripe] checkout_url=${checkoutUrl}`);

  // Best-effort publish/close to confirm funds are usable (requires verified origin for this org).
  const tryPublish = String(process.env.SMOKE_PUBLISH_BOUNTY ?? 'true').trim().toLowerCase();
  if (tryPublish === 'true' || tryPublish === '1' || tryPublish === 'yes') {
    const origin = String(process.env.SMOKE_ORIGIN ?? 'https://example.com');
    const taskType = `smoke_stripe_${tsSuffix()}`;

    const appReg = await fetchJson({
      baseUrl,
      path: '/api/org/apps',
      method: 'POST',
      headers: authHeader,
      body: {
        slug: `smoke-${Date.now()}`,
        taskType,
        name: 'Stripe Smoke App',
        description: 'auto-created by smoke_stripe_remote.ts',
        public: false,
        dashboardUrl: '/apps/',
      },
    });
    if (!appReg.ok && appReg.status !== 409) throw new Error(`app_register_failed:${appReg.status}:${appReg.text}`);

    const bounty = await fetchJson({
      baseUrl,
      path: '/api/bounties',
      method: 'POST',
      headers: authHeader,
      body: {
        title: `Stripe smoke bounty ${new Date().toISOString()}`,
        description: 'Smoke test bounty (Stripe funding).',
        allowedOrigins: [origin],
        disputeWindowSec: 0,
        requiredProofs: 1,
        fingerprintClassesRequired: ['desktop_us'],
        payoutCents: 100,
        taskDescriptor: {
          schema_version: 'v1',
          type: taskType,
          capability_tags: ['http', 'llm_summarize'],
          input_spec: { url: 'https://example.com', query: 'example' },
          output_spec: { http_response: true, required_artifacts: [{ kind: 'log', label: 'report_summary' }] },
          freshness_sla_sec: 3600,
        },
      },
    });

    if (!bounty.ok) {
      const code = String(bounty.json?.error?.code ?? '');
      if (code === 'origin_not_verified') {
        console.log(`[smoke_stripe] publish_check_skipped: origin not verified for org (origin=${origin})`);
      } else {
        throw new Error(`bounty_create_failed:${bounty.status}:${bounty.text}`);
      }
    } else {
      const bountyId = String(bounty.json?.id ?? '');
      if (!bountyId) throw new Error('bounty_create_missing_id');

      const pub = await fetchJson({
        baseUrl,
        path: `/api/bounties/${encodeURIComponent(bountyId)}/publish`,
        method: 'POST',
        headers: authHeader,
      });
      if (!pub.ok) throw new Error(`bounty_publish_failed:${pub.status}:${pub.text}`);

      const closed = await fetchJson({
        baseUrl,
        path: `/api/bounties/${encodeURIComponent(bountyId)}/close`,
        method: 'POST',
        headers: authHeader,
      });
      if (!closed.ok) throw new Error(`bounty_close_failed:${closed.status}:${closed.text}`);

      console.log(`[smoke_stripe] bounty_publish_and_close_ok bounty_id=${bountyId}`);
    }
  }

  console.log('[smoke_stripe] OK');
}

main().catch((err) => {
  console.error('[smoke_stripe] FAILED', err);
  process.exitCode = 1;
});
