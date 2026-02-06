// Remote Stripe top-up smoke test for a deployed Proofwork environment (REAL Checkout).
//
// This script verifies the buyer funding path with an actual Stripe Checkout flow:
// - creates a buyer API key (or self-serve registers a new org)
// - creates a Stripe Checkout Session via the API
// - uses Playwright to complete the Checkout (test card)
// - polls /api/billing/account until balance increases
//
// Usage:
//   BASE_URL=https://... npm run smoke:stripe:real:remote
//
// Notes:
// - This is intended for staging environments. It requires:
//   - STRIPE_SECRET_KEY configured in the backend
//   - STRIPE_WEBHOOK_SECRET set to Stripe-provided whsec_...
//   - PUBLIC_BASE_URL is HTTPS (CloudFront default TLS is fine)
// - Do not print secrets.

import { chromium, type Frame, type Page } from 'playwright';

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
    body: { email: input.email, password: input.password, name: `smoke-stripe-real-${tsSuffix()}` },
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
      orgName: process.env.SMOKE_ORG_NAME ?? `Smoke Stripe Real Org ${tsSuffix()}`,
      email,
      password,
      apiKeyName: process.env.SMOKE_API_KEY_NAME ?? 'default',
    },
  });

  if (!reg.ok) {
    const code = String(reg.json?.error?.message ?? '');
    if (reg.status === 409 && code.includes('email_already_registered')) {
      const retry = await fetchJson({
        baseUrl: input.baseUrl,
        path: '/api/org/api-keys',
        method: 'POST',
        body: { email, password, name: `smoke-stripe-real-${tsSuffix()}` },
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

async function findFrameWithSelector(page: Page, selector: string, timeoutMs: number): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const el = await frame.$(selector);
        if (el) return frame;
      } catch {
        // ignore transient frame errors
      }
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`frame_with_selector_not_found:${selector}`);
}

async function fillHostedInput(page: Page, selectors: string[], value: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      for (const frame of page.frames()) {
        try {
          const el = await frame.$(selector);
          if (!el) continue;
          await frame.fill(selector, value);
          return selector;
        } catch {
          // ignore and continue searching
        }
      }
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`hosted_input_not_found:${selectors.join('|')}`);
}

async function hostedInputExists(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    for (const frame of page.frames()) {
      try {
        if (await frame.$(selector)) return true;
      } catch {
        // ignore
      }
    }
  }
  return false;
}

async function fillIfVisible(page: Page, selector: string, value: string) {
  const loc = page.locator(selector);
  if ((await loc.count()) === 0) return;
  const first = loc.first();
  if (!(await first.isVisible().catch(() => false))) return;
  await first.fill(value);
}

async function completeStripeCheckout(input: { checkoutUrl: string; email: string }) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);

    await page.goto(input.checkoutUrl, { waitUntil: 'domcontentloaded' });

    // Some Checkout flows ask for email (we create Stripe customers without email by default).
    await fillIfVisible(page, 'input[name="email"]', input.email);
    await fillIfVisible(page, 'input[type="email"]', input.email);

    // Some Checkout flows show Link by default (email + phone) and require selecting "Card".
    await fillIfVisible(page, 'input[name="phoneNumber"]', '(201) 555-0123');

    const cardRadio = page.locator('#payment-method-accordion-item-title-card');
    if ((await cardRadio.count().catch(() => 0)) > 0) {
      // Use click over check; Checkout sometimes overlays the input with a styled label.
      await cardRadio.first().click({ timeout: 10_000 }).catch(() => undefined);
    }

    // Choose "Card" explicitly if multiple payment methods are shown (best-effort).
    const cardTab = page.getByRole('tab', { name: /card/i });
    if ((await cardTab.count().catch(() => 0)) > 0) {
      await cardTab.first().click().catch(() => undefined);
    }

    // Card fields are typically hosted in Stripe iframes (Elements/Checkout). Use a selector set to be resilient
    // to Checkout UI changes.
    const cardSelectors = [
      'input[name="cardnumber"]',
      'input[autocomplete="cc-number"]',
      'input[data-elements-stable-field-name="cardNumber"]',
      'input[aria-label*="card number" i]',
      'input[placeholder*="1234" i]',
    ];

    // Some Checkout configurations show a "Continue/Next" step before card details are rendered.
    if (!(await hostedInputExists(page, cardSelectors))) {
      const continueBtn = page.getByRole('button', { name: /continue|next/i });
      if ((await continueBtn.count().catch(() => 0)) > 0) {
        await continueBtn.first().click().catch(() => undefined);
        await page.waitForTimeout(1500);
      }
    }

    await fillHostedInput(
      page,
      cardSelectors,
      '4242 4242 4242 4242',
      60_000
    );

    await fillHostedInput(
      page,
      [
        'input[name="exp-date"]',
        'input[autocomplete="cc-exp"]',
        'input[data-elements-stable-field-name="cardExpiry"]',
        'input[aria-label*="expiration" i]',
        'input[placeholder*="MM" i]',
      ],
      '12 / 34',
      60_000
    );

    await fillHostedInput(
      page,
      [
        'input[name="cvc"]',
        'input[autocomplete="cc-csc"]',
        'input[data-elements-stable-field-name="cardCvc"]',
        'input[aria-label*="security" i]',
        'input[aria-label*="cvc" i]',
      ],
      '123',
      60_000
    );

    // Postal code is optional depending on settings; try if present.
    await fillHostedInput(
      page,
      ['input[name="postal"]', 'input[autocomplete="postal-code"]', 'input[data-elements-stable-field-name="postalCode"]'],
      '94103',
      2_000
    ).catch(() => undefined);

    // Click pay/submit.
    const payByRole = page.getByRole('button', { name: /pay|purchase|checkout/i });
    if ((await payByRole.count().catch(() => 0)) > 0) {
      await payByRole.first().click();
    } else {
      await page.locator('button[type="submit"]').first().click();
    }

    // Success is typically a redirect to success_url or a success screen.
    await Promise.race([
      page.waitForURL((u) => !u.hostname.includes('checkout.stripe.com'), { timeout: 90_000 }),
      page.getByText(/payment successful|thank you/i).first().waitFor({ timeout: 90_000 }),
    ]).catch(() => undefined);
  } finally {
    await browser.close();
  }
}

async function pollBalanceDelta(input: {
  baseUrl: string;
  authHeader: Record<string, string>;
  before: number;
  expectedDelta: number;
  timeoutMs: number;
}) {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const acct = await fetchJson({ baseUrl: input.baseUrl, path: '/api/billing/account', headers: input.authHeader });
    if (acct.ok) {
      const after = Number(acct.json?.account?.balance_cents ?? 0);
      const delta = after - input.before;
      if (delta === input.expectedDelta) return { after };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('stripe_real_checkout_timeout_waiting_for_balance_update');
}

async function main() {
  const baseUrl = normalizeBaseUrl(argValue('--base-url') ?? process.env.BASE_URL ?? 'http://localhost:3000');

  const email = mustEnv('SMOKE_BUYER_EMAIL', 'buyer@example.com');
  const password = mustEnv('SMOKE_BUYER_PASSWORD', 'password');
  const topupCentsRaw = Number(process.env.SMOKE_TOPUP_CENTS ?? 500);
  const topupCents = Number.isFinite(topupCentsRaw) ? Math.max(100, Math.min(50_000, Math.floor(topupCentsRaw))) : 500;

  // Health
  const health = await fetchJson({ baseUrl, path: '/health' });
  if (!health.ok) throw new Error(`health_failed:${health.status}`);

  const auth = await ensureBuyerAuth({ baseUrl, email, password });
  const buyerToken = auth.buyerToken;
  const authHeader = { authorization: `Bearer ${buyerToken}` };

  const acct0 = await fetchJson({ baseUrl, path: '/api/billing/account', headers: authHeader });
  if (!acct0.ok) throw new Error(`billing_account_failed:${acct0.status}`);
  const before = Number(acct0.json?.account?.balance_cents ?? 0);

  const successUrl = String(process.env.SMOKE_SUCCESS_URL ?? `${baseUrl}/buyer`);
  const cancelUrl = String(process.env.SMOKE_CANCEL_URL ?? successUrl);

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

  console.log(`[smoke_stripe_real] base_url=${baseUrl}`);
  console.log(`[smoke_stripe_real] topup_cents=${topupCents} before=${before}`);
  console.log(`[smoke_stripe_real] stripe_session_id=${stripeSessionId}`);
  console.log(`[smoke_stripe_real] checkout_url=${checkoutUrl}`);

  await completeStripeCheckout({ checkoutUrl, email: auth.email });

  const polled = await pollBalanceDelta({ baseUrl, authHeader, before, expectedDelta: topupCents, timeoutMs: 90_000 });
  console.log(`[smoke_stripe_real] after=${polled.after} delta=${polled.after - before}`);

  console.log('[smoke_stripe_real] ok');
}

main().catch((err) => {
  console.error('[smoke_stripe_real] failed', err);
  process.exitCode = 1;
});
