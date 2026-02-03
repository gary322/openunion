# Tokens + rotation runbook

This system has three token classes:

## 1) Worker tokens
- Issued by `POST /api/workers/register`
- Stored server-side as:
  - `key_prefix` (first N chars)
  - `key_hash` (HMAC-SHA256(token, WORKER_TOKEN_PEPPER)) with legacy SHA256 fallback

Rotate procedure:
1) Set a new `WORKER_TOKEN_PEPPER` in prod.
2) Roll API + workers.
3) Force workers to re-register / rotate tokens (old tokens will stop authenticating once pepper changes).

## 2) Buyer org API keys
- Issued by `POST /api/org/api-keys` (or session route `/api/session/api-keys`).
- New platform onboarding can be done via `POST /api/org/register` which creates:
  - an org
  - an owner user
  - an initial org API key (returned as `token`)
- Hashed with `BUYER_TOKEN_PEPPER` (defaults to `WORKER_TOKEN_PEPPER`).

Rotate procedure:
1) Rotate org API keys (issue new, revoke old).
2) If needed, rotate `BUYER_TOKEN_PEPPER` (forces re-issuance).

## 3) Admin + verifier tokens
Recommended production posture:
- Do not ship plaintext `ADMIN_TOKEN` / `VERIFIER_TOKEN` in configs.
- Use `*_TOKEN_HASH` + `*_TOKEN_PEPPER` instead:
  - `ADMIN_TOKEN_HASH`, `ADMIN_TOKEN_PEPPER`
  - `VERIFIER_TOKEN_HASH`, `VERIFIER_TOKEN_PEPPER`

Rotation procedure (hashed tokens):
1) Generate a new random token preimage (the string used by internal clients).
2) Compute `HMAC-SHA256(token, pepper)` and set `*_TOKEN_HASH` and `*_TOKEN_PEPPER` in prod.
3) Distribute the new token preimage to internal verifier components (verification worker + verifier gateway).
4) Roll services.

## Security notes
- Never place secrets inside `task_descriptor` (treated as metadata).
- In production, set `WORKER_TOKEN_PEPPER`, `BUYER_TOKEN_PEPPER`, `SESSION_SECRET` to non-default values.
- Prefer running verifier components on internal networks only.
