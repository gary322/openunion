# Stripe (buyer top-ups) runbook

This repo supports buyer balance funding via Stripe Checkout:
- Create checkout session: `POST /api/billing/topups/checkout`
- Credit balance via webhook: `POST /api/webhooks/stripe` (signature verified)

This runbook focuses on **AWS ECS** environments created by `infra/terraform`.

## What you need

- A Stripe account.
- A Stripe **secret key**:
  - Staging: `sk_test_...`
  - Production: `sk_live_...` (only when you are ready for real money)
- A Stripe **webhook signing secret**: `whsec_...`
  - You get this when you create a webhook endpoint in Stripe.
- AWS credentials that can:
  - write Secrets Manager values
  - update ECS services/task definitions

## URLs

- Webhook endpoint (public):
  - `POST https://<PUBLIC_BASE_URL>/api/webhooks/stripe`
- Checkout redirect URLs:
  - `successUrl`, `cancelUrl` (caller-provided in `POST /api/billing/topups/checkout`)
  - If omitted by the caller, the API uses `PUBLIC_BASE_URL` as a default.

Note: Stripe webhooks generally require an HTTPS public URL you control. If you do not have one yet, you can still run the **deterministic smoke** below (it simulates the webhook).

## Enable Stripe (staging or production) + smoke

The ops script below makes this reproducible end-to-end:
- updates the Stripe secrets in AWS Secrets Manager
- ensures the ECS API task definition injects the Stripe secrets (patches if needed)
- forces a redeploy so tasks pick up the new secret values
- runs the remote Stripe smoke (`scripts/smoke_stripe_remote.ts`)

### 1) Put keys into local files (avoid shell history)

```bash
umask 077
printf "%s" "sk_test_..." > /tmp/stripe_sk.txt
printf "%s" "whsec_..." > /tmp/stripe_whsec.txt
```

### 2) Run the enable+smoke script

Staging:

```bash
npm run ops:stripe:enable -- \
  --env staging \
  --stripe-secret-key-file /tmp/stripe_sk.txt \
  --stripe-webhook-secret-file /tmp/stripe_whsec.txt
```

Production (test mode):

```bash
npm run ops:stripe:enable -- \
  --env production \
  --stripe-secret-key-file /tmp/stripe_sk.txt \
  --stripe-webhook-secret-file /tmp/stripe_whsec.txt
```

Cleanup:

```bash
rm -f /tmp/stripe_sk.txt /tmp/stripe_whsec.txt
```

### Deterministic smoke without a real Stripe webhook secret

If you do not have an HTTPS URL and real webhook endpoint yet, you can generate a webhook secret (only used for signature verification in the simulated webhook smoke):

```bash
npm run ops:stripe:enable -- \
  --env staging \
  --stripe-secret-key-file /tmp/stripe_sk.txt \
  --generate-webhook-secret
```

## Verifying real Stripe (non-simulated)

To verify “real Stripe delivers webhooks”:
1. Ensure `PUBLIC_BASE_URL` is HTTPS and points to the API.
2. In Stripe, create a webhook endpoint to:
   - `https://<PUBLIC_BASE_URL>/api/webhooks/stripe`
   - event(s): `checkout.session.completed`
3. Update `STRIPE_WEBHOOK_SECRET` to the Stripe-provided `whsec_...`.
4. Redeploy API tasks (the ops script above does this).
5. Run a real checkout in a browser (Stripe test mode: `4242 4242 4242 4242`) and confirm the buyer’s balance increased.

### Rotate webhook secret + disable duplicates (recommended)

If you have multiple webhook endpoints pointing at the same URL, you can rotate to a fresh `whsec_...` and disable duplicates safely:

```bash
npm run ops:stripe:webhook:rotate -- --env staging
```

This will:
- create a new Stripe webhook endpoint for `https://<PUBLIC_BASE_URL>/api/webhooks/stripe`
- update `STRIPE_WEBHOOK_SECRET` in AWS Secrets Manager
- force-redeploy the API tasks
- run the deterministic Stripe smoke
- disable any other enabled webhook endpoints that point at the exact same URL

### Automated real Checkout smoke (Playwright)

You can run a real Stripe Checkout smoke (recommended for staging when `PUBLIC_BASE_URL` is HTTPS):

```bash
BASE_URL=https://<PUBLIC_BASE_URL> npm run smoke:stripe:real:remote
```

This will:
- create a buyer (or reuse `SMOKE_BUYER_EMAIL` / `SMOKE_BUYER_PASSWORD`)
- create a Checkout Session

By default, the script prints the `checkout_url` and waits for you to complete it in a real browser (Stripe may show bot mitigation that makes headless automation unreliable). The script does **not** auto-open your browser unless you set `SMOKE_OPEN_CHECKOUT_URL=true`.

Tip: the printed Checkout URL includes a `#...` fragment. If you copy only the part before `#`, Stripe may show "The page you were looking for could not be found".

The smoke also writes the full URL to a local file (`checkout_url_file=...`). On macOS you can open it without copy/paste issues via:

```bash
open "$(cat /tmp/proofwork_stripe_checkout_url_*.txt)"
```

#### Two-step flow (recommended for chat/CI runners)

If you want to separate “create session” from “verify webhook delivered” (useful when the runner cannot show you the URL interactively):

1) Create the Checkout Session and exit:

```bash
BASE_URL=https://<PUBLIC_BASE_URL> npm run smoke:stripe:real:remote -- --create-only
```

2) Complete the payment in a real browser.

3) Verify the webhook delivered (use the `receipt_file=...` printed in step 1):

```bash
SMOKE_RECEIPT_FILE=/tmp/proofwork_stripe_real_receipt_...json \
  BASE_URL=https://<PUBLIC_BASE_URL> \
  npm run smoke:stripe:real:remote -- --verify-only
```

If you want to *attempt* automation via Playwright:

```bash
BASE_URL=https://<PUBLIC_BASE_URL> SMOKE_AUTOMATE_CHECKOUT=true npm run smoke:stripe:real:remote
```

The smoke passes when `/api/billing/account` shows the expected balance increase from the real Stripe webhook.
## Troubleshooting

- `STRIPE_SECRET_KEY not configured`:
  - Stripe secret key is empty/missing in the API environment.
  - Fix: set the secret and redeploy (`npm run ops:stripe:enable ...`).
- `stripe_signature_mismatch`:
  - `STRIPE_WEBHOOK_SECRET` does not match what you used to sign the webhook.
  - Fix: ensure the same `whsec_...` is used by Stripe (real) or by the smoke script (simulated).
- Checkout works but balance never increases (real flow):
  - Stripe webhook is not delivering (wrong URL, not HTTPS, blocked) or failing signature verification.
  - Check Stripe dashboard webhook deliveries and API logs for `/api/webhooks/stripe`.
