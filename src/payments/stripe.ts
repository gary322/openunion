import { createHmac, timingSafeEqual } from 'crypto';

export interface StripeCheckoutSession {
  id: string;
  url: string;
  amount_total?: number;
  currency?: string;
  payment_status?: string;
  metadata?: Record<string, string>;
}

export interface StripeEvent<T = any> {
  id: string;
  type: string;
  created: number;
  data: { object: T };
}

function requireStripeSecretKey() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
  return key;
}

export function requireStripeWebhookSecret() {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not configured');
  return secret;
}

function stripeAuthHeader() {
  return `Bearer ${requireStripeSecretKey()}`;
}

function formEncode(fields: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    params.set(k, String(v));
  }
  return params;
}

export async function stripeCreateCustomer(input: { email?: string; orgId: string }): Promise<{ id: string }> {
  const params = formEncode({
    email: input.email,
    'metadata[orgId]': input.orgId,
  });

  const resp = await fetch('https://api.stripe.com/v1/customers', {
    method: 'POST',
    headers: {
      Authorization: stripeAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const json = (await resp.json()) as any;
  if (!resp.ok) throw new Error(`stripe_create_customer_failed:${resp.status}:${json?.error?.message ?? 'unknown'}`);
  if (!json?.id) throw new Error('stripe_create_customer_invalid_response');
  return { id: String(json.id) };
}

export async function stripeCreateCheckoutSession(input: {
  customerId?: string;
  amountCents: number;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}): Promise<{ id: string; url: string }> {
  if (!Number.isFinite(input.amountCents) || input.amountCents <= 0) throw new Error('invalid_amount');
  if (!input.successUrl || !input.cancelUrl) throw new Error('missing_success_or_cancel_url');

  const fields: Record<string, string | number | undefined> = {
    mode: 'payment',
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    customer: input.customerId,
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': input.amountCents,
    'line_items[0][price_data][product_data][name]': 'Proofwork balance top-up',
    'line_items[0][quantity]': 1,
  };
  for (const [k, v] of Object.entries(input.metadata)) {
    fields[`metadata[${k}]`] = v;
  }

  const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: stripeAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formEncode(fields).toString(),
  });

  const json = (await resp.json()) as any;
  if (!resp.ok) throw new Error(`stripe_create_checkout_failed:${resp.status}:${json?.error?.message ?? 'unknown'}`);
  if (!json?.id || !json?.url) throw new Error('stripe_create_checkout_invalid_response');
  return { id: String(json.id), url: String(json.url) };
}

// Stripe webhook verification (v1 signature)
// Header: "t=1492774577,v1=5257a869e7...,v0=..."
export function verifyStripeWebhookSignature(input: {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  webhookSecret: string;
  toleranceSec?: number;
}): StripeEvent {
  const header = input.signatureHeader ?? '';
  const parts = header.split(',').map((p) => p.trim());
  const tPart = parts.find((p) => p.startsWith('t='));
  const v1Parts = parts.filter((p) => p.startsWith('v1='));
  if (!tPart || v1Parts.length === 0) throw new Error('stripe_signature_missing');

  const timestamp = Number(tPart.slice(2));
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error('stripe_signature_bad_timestamp');

  const tolerance = input.toleranceSec ?? 300;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > tolerance) throw new Error('stripe_signature_timestamp_out_of_tolerance');

  const signedPayload = Buffer.from(`${timestamp}.${input.rawBody.toString('utf8')}`, 'utf8');
  const digest = createHmac('sha256', input.webhookSecret).update(signedPayload).digest('hex');

  const digestBuf = Buffer.from(digest, 'utf8');
  const ok = v1Parts.some((p) => {
    const sig = p.slice(3);
    const sigBuf = Buffer.from(sig, 'utf8');
    if (sigBuf.length !== digestBuf.length) return false;
    return timingSafeEqual(sigBuf, digestBuf);
  });
  if (!ok) throw new Error('stripe_signature_mismatch');

  const evt = JSON.parse(input.rawBody.toString('utf8')) as StripeEvent;
  if (!evt?.id || !evt?.type) throw new Error('stripe_event_invalid');
  return evt;
}

