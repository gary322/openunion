# Universal Worker runbook

This repo includes a reference Universal Worker at `skills/universal-worker/worker.ts`.

It demonstrates:
- Capability-driven job discovery (`capability_tags` subset matching).
- Idempotent submission (`Idempotency-Key`).
- Upload + submit flow using the existing Proofwork rails.

## Setup (local)
Start API and workers:
- `npm run dev`
- `npm run worker:outbox`
- `npm run worker:verification`
- `npm run worker:payout`

Run the verifier gateway (optional but recommended for verification):
- `npm run verifier:gateway`

Run the universal worker:
- `npm run worker:universal`

## Configuration
Environment variables:
- `API_BASE_URL` (defaults to `http://localhost:3000`)
- `WORKER_TOKEN` (optional; if omitted the script registers a new worker)
- `SUPPORTED_CAPABILITY_TAGS` (CSV, default `browser,http,screenshot,llm_summarize`; enable `ffmpeg` only if the runtime has ffmpeg)
- `PREFER_CAPABILITY_TAG` (optional)
- `MIN_PAYOUT_CENTS` (optional)
- `UNIVERSAL_WORKER_CANARY_PERCENT` (0..100, default `100`) – deterministically claim only a % of jobs (hash(jobId))
- `ONCE=true` to exit after one submit
- `WAIT_FOR_DONE=true` to poll until `status=done`

## Backpressure / kill switches
Worker intake may be paused by:
- `UNIVERSAL_WORKER_PAUSE=true`
- `MAX_VERIFIER_BACKLOG` (count-based)
- `MAX_VERIFIER_BACKLOG_AGE_SEC` (age-based)
- `MAX_OUTBOX_PENDING_AGE_SEC` (age-based)
- `MAX_ARTIFACT_SCAN_BACKLOG_AGE_SEC` (age-based)

When paused, `/api/jobs/next` returns `state=idle` with a reason string.

## Idempotency
`POST /api/jobs/:jobId/submit` is safe to retry:
- Provide `Idempotency-Key: <unique value>`
- Retries return the original submission instead of creating duplicates.

## Production hardening checklist (worker-side)
- Canary rollout: start `UNIVERSAL_WORKER_CANARY_PERCENT=1..10` and increase as verifiers/queues stay healthy.
- Run workers in separate pools by capability (e.g. “ffmpeg pool”).
- Cap concurrency (`WORKER_MAX_CONCURRENCY` in your worker container/runtime).
- Keep secrets in a secret manager; never embed tokens in descriptors.
- Prefer allowlisted egress, and sandbox browsers.
