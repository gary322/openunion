# Third-Party Platform Onboarding (Self-Serve)

This runbook shows how an external platform can attach to Proofwork/OpenUnion, publish tasks, and get paid.

Principles:
- **No admin approval required** for app publishing.
- **Third-party browser UIs** are supported via **per-org CORS allowlist**.
- **Disputes posture**: default **1 day hold window** (production). During the hold window, a buyer can open a dispute. After the window, an auto-refund runs (refund = gross - Proofwork fee).

---

## 0) Preconditions

- You can reach the API base URL (staging or production).
- You have a verified domain you control (required for `allowedOrigins`).

---

## 1) Create your org + first API key

Create an org and get a buyer token (`pw_bu_...`) which is used as `Authorization: Bearer ...` for buyer APIs.

```bash
curl -sS -X POST "$BASE_URL/api/org/register" \
  -H 'content-type: application/json' \
  -d '{
    "orgName":"Acme Platform",
    "email":"owner@acme.example",
    "password":"change_me_strong_password",
    "apiKeyName":"default"
  }'
```

Response includes:
- `orgId`
- `token` (buyer bearer token)

---

## 2) Verify your origin (required before publishing bounties)

Proofwork uses an origin verification rail. Any `allowedOrigins` you publish must be verified.

Create origin verification:

```bash
curl -sS -X POST "$BASE_URL/api/origins" \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "origin":"https://app.acme.example",
    "method":"http_file"
  }'
```

Then place the returned token at:
- `https://app.acme.example/.well-known/proofwork-verify.txt`

Check verification:

```bash
curl -sS -X POST "$BASE_URL/api/origins/$ORIGIN_ID/check" \
  -H "Authorization: Bearer $BUYER_TOKEN"
```

Status must become `verified`.

---

## 3) (Optional) Enable third-party browser UIs (per-org CORS allowlist)

If your own web app will call Proofwork APIs directly from the browser, add your UI origins:

```bash
curl -sS -X PUT "$BASE_URL/api/org/cors-allow-origins" \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "origins":[
      "https://app.acme.example",
      "https://dashboard.acme.example"
    ]
  }'
```

Notes:
- Requests without an `Origin` header (server-to-server) are allowed.
- Browser requests with an `Origin` header must match an allowlisted origin.

---

## 4) Set your platform fee (your cut) + wallet

Your org can set its own cut. Proofwork always takes a fixed 1% fee from the worker payout.

```bash
curl -sS -X PUT "$BASE_URL/api/org/platform-fee" \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "platformFeeBps": 250,
    "platformFeeWalletAddress":"0x0000000000000000000000000000000000000000"
  }'
```

---

## 5) Register your app type (no admin approval)

Apps map a `task_descriptor.type` to a dashboard URL and a default descriptor template.

```bash
curl -sS -X POST "$BASE_URL/api/org/apps" \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "slug":"acme-research",
    "taskType":"acme_research_plan",
    "name":"Acme Research",
    "description":"Idea → research plan",
    "dashboardUrl":"https://app.acme.example/proofwork",
    "public": true,
    "defaultDescriptor":{
      "schema_version":"v1",
      "type":"acme_research_plan",
      "capability_tags":["http","llm_summarize"],
      "input_spec":{"idea":""},
      "output_spec":{"required_artifacts":[{"kind":"log","label_prefix":"report"}]},
      "freshness_sla_sec":86400
    }
  }'
```

Important:
- The `taskType` is **reserved** for the owning org. Other orgs cannot publish bounties with your `taskType`.

---

## 6) Create + publish a bounty with a task_descriptor

```bash
curl -sS -X POST "$BASE_URL/api/bounties" \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "title":"Research plan: X",
    "description":"Generate a research plan for idea X",
    "allowedOrigins":["https://app.acme.example"],
    "requiredProofs":1,
    "fingerprintClassesRequired":["desktop_us"],
    "payoutCents":1500,
    "taskDescriptor":{
      "schema_version":"v1",
      "type":"acme_research_plan",
      "capability_tags":["http","llm_summarize"],
      "input_spec":{"idea":"my idea"},
      "output_spec":{"required_artifacts":[{"kind":"log","label_prefix":"report"}]},
      "freshness_sla_sec":86400
    }
  }'
```

Then publish:

```bash
curl -sS -X POST "$BASE_URL/api/bounties/$BOUNTY_ID/publish" \
  -H "Authorization: Bearer $BUYER_TOKEN"
```

Publishing requires sufficient budget (top-up required).

---

## 7) Monitor + payouts + disputes

- Buyer portal: `/buyer/index.html`
  - earnings: `GET /api/org/earnings`
  - payouts history: `GET /api/org/payouts`
  - disputes: `POST /api/org/disputes`
- Worker portal: `/worker/index.html`
  - payout address verification: `POST /api/worker/payout-address`
  - payout history: `GET /api/worker/payouts`
- Admin portal: `/admin/index.html`
  - payouts reconciliation: `/admin/payouts.html`
  - disputes: `/admin/disputes.html`
  - alerts: `/admin/alerts.html`

---

## Troubleshooting

- `origin_not_verified`: verify your `allowedOrigins` via the origin verification rail.
- `task_descriptor_sensitive`: descriptor looks like it contains secrets; move secrets to env/secret manager (never embed in descriptor).
- `forbidden_task_type_owner`: your bounty used a `task_descriptor.type` owned by another org; register your own app/taskType.

