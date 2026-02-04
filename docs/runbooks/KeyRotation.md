# Key rotation runbook (AWS, GitHub, Stripe, Slack/PagerDuty)

This doc is intentionally practical: what to rotate, when, and what breaks.

Related docs:
- `docs/runbooks/Tokens.md` (worker/buyer/admin/verifier token rotation)
- `docs/runbooks/Deploy.md`

## Principles
- Never commit secrets. `.env` is gitignored; CI fails if it becomes tracked.
- Prefer **AWS OIDC** for GitHub Actions deployments (no long-lived AWS keys in CI).
- Rotate when:
  - a secret is exposed (copy/paste, screenshot, logs, git history), or
  - on a fixed cadence (e.g. quarterly), or
  - an operator leaves the team.

## 1) AWS access keys (local `.env`)

This repo supports local AWS credentials for developer tooling (Terraform, smoke, etc) via `.env`.

If an AWS access key was ever pasted anywhere outside your password manager, rotate it.

Steps (IAM user access keys):
1) Create a new access key for the IAM user.
2) Update local `.env`:
   - `AWS_ACCESS_KEY_ID=...`
   - `AWS_SECRET_ACCESS_KEY=...`
3) Verify:
   - `aws sts get-caller-identity`
4) Disable the old key.
5) Delete the old key after a short safe window.

Notes:
- GitHub Actions deploy does not use these keys (it uses OIDC).
- If you suspect compromise, also review CloudTrail for that IAM user.

## 2) GitHub Actions (OIDC) deploy roles

Deploy is done via GitHub OIDC assuming roles:
- `openunion-github-staging-deploy`
- `openunion-github-prod-deploy`

Rotation is "policy/role" oriented, not "key" oriented:
- Restrict the trust policy to the correct repository + environment claims.
- Rotate permissions by tightening IAM policies.
- If you change environment names, OIDC trust can break (CI guards against this).

## 3) GitHub tokens (humans/tools)

If you use `gh` locally, your token scopes are visible via:
```bash
gh auth status
```

Rotation:
1) Create a new token with the minimum scopes needed.
2) Update local keychain / automation.
3) Revoke the old token.

## 4) GitHub deploy keys (SSH)

Deploy keys are not used by GitHub Actions deploy (OIDC is used instead).

If you keep a deploy key for an external system:
- Store the private key only in that external system.
- Ensure file permissions: `chmod 600`.

Rotate:
1) Generate a new SSH key pair (ed25519 recommended).
2) Add the public key in GitHub → Settings → Deploy keys (write access only if truly needed).
3) Update the external system to use the new private key.
4) Remove the old deploy key from GitHub.

## 5) Stripe secrets (billing + webhooks)

Secrets:
- `STRIPE_SECRET_KEY` (server-side API)
- `STRIPE_WEBHOOK_SECRET` (signature verification)

Rotation:
1) Create a new API key in Stripe.
2) Update Secrets Manager for each environment:
   - `proofwork-staging/STRIPE_SECRET_KEY`
   - `proofwork-prod/STRIPE_SECRET_KEY`
3) For webhook secret:
   - Create a new webhook endpoint OR rotate signing secret if supported.
   - Update:
     - `proofwork-staging/STRIPE_WEBHOOK_SECRET`
     - `proofwork-prod/STRIPE_WEBHOOK_SECRET`
4) Deploy services.
5) Confirm:
   - Stripe top-ups work
   - webhook deliveries are succeeding

## 6) Slack / PagerDuty / Opsgenie (alert subscriptions)

Alarms publish to SNS topics. Subscriptions are what deliver alerts to humans.

If using Slack:
- AWS Chatbot is the recommended integration.
- Rotate by updating the Slack channel configuration / workspace authorization.

If using PagerDuty/Opsgenie:
- Rotate by updating the HTTPS subscription endpoint and its auth token.

After any change:
- Run `bash scripts/ops/test_alarm_notifications.sh ...` (see `docs/runbooks/Alerting.md`)

## 7) Payout signing key (AWS KMS)

For on-chain payouts (`PAYMENTS_PROVIDER=crypto_base_usdc`), the payout worker signs from:
- `KMS_PAYOUT_KEY_ID`

Rotation options:
- Prefer rotating the **KMS key** by creating a new key and switching config.
- Fund the new signer EVM address with ETH (gas) + USDC (payouts).
- Approve USDC allowance for the splitter (see `docs/runbooks/Payouts.md`).

After rotation:
- Run a small-dollar canary payout end-to-end in staging, then production.

