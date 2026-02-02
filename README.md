# Proofwork

Fastify + Zod API for a Verified Change Bounties workflow, now **DB-backed (Postgres)** with **outbox workers**, **storage presign (local + S3)**, **retention**, **audit logging**, **DB-backed rate limiting**, **metrics**, and minimal web portals.

## Quick start (local Postgres)

```bash
npm install

# create the database once (example)
createdb proofwork

export DATABASE_URL=postgresql://localhost:5432/proofwork
npm run db:migrate

npm test
npm run test:e2e
npm run dev
```

## Quick start (Docker Postgres + MinIO)

```bash
docker compose up -d postgres minio

export DATABASE_URL=postgresql://postgres:postgres@localhost:5433/proofwork
npm run db:migrate

npm run dev
```

## Testing & load

```bash
# Unit/integration suite (Vitest)
npm test

# E2E (Playwright) - starts the API automatically (requires DB running)
npm run test:e2e

# Simple load test for /api/jobs/next (requires a worker token)
WORKER_TOKEN=... npm run load:jobs-next
```

## Workers

You can run a single multi-topic dispatcher or per-topic workers:

```bash
npm run worker:outbox

# or
npm run worker:verification
npm run worker:payout
npm run worker:retention
npm run worker:scanner

# Verifier gateway (local)
npm run verifier:gateway
```

Notes:
- **Verification runner** requires `VERIFIER_GATEWAY_URL` (an HTTP endpoint that runs verifier agents and returns a verdict payload).
- For **S3 uploads**, workers should call `POST /api/uploads/complete` after uploading to the presigned URL so the system can enqueue scanning.

## Task descriptors (Universal Worker)

- Bounties/jobs may include an optional `taskDescriptor` JSON (validated, max size 16 KB by default) with fields: `schema_version`, `type`, `capability_tags[]` (allowlist: browser, http, ffmpeg, llm_summarize, screenshot), `input_spec`, `output_spec`, optional `freshness_sla_sec`, optional `site_profile`.
- The worker `GET /api/jobs/next` endpoint supports:
  - `capability_tags=<csv>` (subset match: job tags must be a subset of the worker’s supported tags)
  - `capability_tag=<tag>` (job must include this tag)
  - `min_payout_cents=<int>`
  The job spec returns `taskDescriptor` so Universal Workers can self-select and execute compatible work.

### OpenClaw worker integration (optional)

If you want an OpenClaw install to act as a Proofwork worker, see:
- `docs/runbooks/OpenClawWorker.md`

## Portals

With `npm run dev` running:

- Worker portal: `http://localhost:3000/worker`
- Buyer portal: `http://localhost:3000/buyer`
- Admin console: `http://localhost:3000/admin`
- Descriptor builder: `http://localhost:3000/admin/descriptor-builder.html`

## Metrics

- `GET /health/metrics` exposes Prometheus-format metrics.

## Environment variables

See `env.example` for a starting point.

**Local config**: Optionally create a `.env` file in the project root (it's gitignored) for local development configuration. For production, use your platform’s **secret manager / environment variables**. Never commit secrets or paste them into chat. Example:

```bash
cp env.example .env
# Edit .env with your actual credentials
```

**Note**: The `.env` file is excluded from git via `.gitignore`. Never commit credentials to version control.

### Database
- `DATABASE_URL`: Postgres connection string.

### Auth
- `WORKER_TOKEN_PEPPER`: HMAC pepper for worker token hashing (stored as prefix + HMAC hash).
- `BUYER_TOKEN_PEPPER`: HMAC pepper for buyer API key hashing (defaults to `WORKER_TOKEN_PEPPER`).
- `ADMIN_TOKEN` or `ADMIN_TOKEN_HASH` (+ `ADMIN_TOKEN_PEPPER`)
- `VERIFIER_TOKEN` or `VERIFIER_TOKEN_HASH` (+ `VERIFIER_TOKEN_PEPPER`)

### Backpressure
- `MAX_VERIFIER_BACKLOG`
- `MAX_VERIFIER_BACKLOG_AGE_SEC`
- `MAX_OUTBOX_PENDING_AGE_SEC`
- `MAX_ARTIFACT_SCAN_BACKLOG_AGE_SEC`
- `MAX_VERIFICATION_ATTEMPTS`
- `UNIVERSAL_WORKER_PAUSE`: set true to pause worker intake for `/api/jobs/next`
- `ENABLE_TASK_DESCRIPTOR`: set false to disable descriptor intake/exposure (rollback lever)
- `TASK_DESCRIPTOR_MAX_BYTES`: max JSON size for task_descriptor (default 16000)
- `TASK_DESCRIPTOR_MAX_DEPTH`: max depth for task_descriptor (default 6)
- `BLOCKED_UPLOAD_CONTENT_TYPES`: comma-separated content-types to reject at presign
- `MIN_PAYOUT_CENTS`: optional floor to avoid micro-payout thrash

### Contracts
- Task descriptor JSON Schema is served at `/contracts/task_descriptor.schema.json`

### Storage
- `STORAGE_BACKEND`: `local` or `s3`
- `STORAGE_LOCAL_DIR`: local filesystem root (default `./var/uploads`)
- `PUBLIC_BASE_URL`: used to construct artifact URLs (default `http://localhost:3000`). If unset, the API falls back to the request Host when generating presigned local upload URLs.
- Artifacts are downloaded via `GET /api/artifacts/:artifactId/download` (local = proxied stream, S3 = redirect to presigned GET)
- `MAX_UPLOAD_BYTES`, `PRESIGN_TTL_SEC`, `ARTIFACT_TTL_DAYS`

S3-compatible (when `STORAGE_BACKEND=s3`):
- `STORAGE_ENDPOINT` (for MinIO/R2), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`
- Buckets:
  - `S3_BUCKET_STAGING` (uploads)
  - `S3_BUCKET_CLEAN` (clean/scanned artifacts; served via signed GET)
  - `S3_BUCKET_QUARANTINE` (infected/blocked)
  - `S3_BUCKET` is an optional fallback if the per-bucket vars are unset

### Payments
- `PAYMENTS_PROVIDER`: `mock`, `http`, or `crypto_base_usdc`
- When `PAYMENTS_PROVIDER=http`: set `PAYMENTS_PROVIDER_URL` (and optionally `PAYMENTS_PROVIDER_AUTH_HEADER`)
- When `PAYMENTS_PROVIDER=crypto_base_usdc`: configure Base RPC + KMS key + splitter contract + Proofwork fee wallet (see `env.example`)
- Proofwork fee (default 1%): `PROOFWORK_FEE_BPS`, `PROOFWORK_FEE_WALLET_BASE` (with safety cap `MAX_PROOFWORK_FEE_BPS`)
- Per-org platform fee (optional, configured by the buyer org via API/UI): `orgs.platform_fee_bps` + `orgs.platform_fee_wallet_address`

## OpenAPI

See `openapi.yaml` for a route summary.
