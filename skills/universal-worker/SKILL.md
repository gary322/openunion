# Universal Worker (Reference Skill)

This is a **descriptor-driven worker** that can self-select compatible jobs and complete them using built-in modules.

It is intentionally generic: new “apps”/verticals should publish a new `task_descriptor` + verifier policy, not a new skill.

## What it supports (v0)
- Job discovery via `GET /api/jobs/next` with `capability_tags` (subset matching).
- Claim via `POST /api/jobs/:jobId/claim`.
- Upload artifacts via `POST /api/uploads/presign` + `PUT` + `POST /api/uploads/complete`.
- Submit via `POST /api/jobs/:jobId/submit` with `Idempotency-Key`.
- Modules:
  - `browser`/`screenshot`: Playwright screenshot of `journey.startUrl` (or `task_descriptor.input_spec.url` if provided).
  - `http`: fetch `task_descriptor.input_spec.url` and upload response as a log artifact.
  - `llm_summarize` (deterministic): upload a `report_summary` log artifact summarizing inputs/outputs and artifacts produced.
  - `ffmpeg` (optional): if `ffmpeg` is installed in the worker runtime, clip `input_spec.vod_url` into `video/mp4` output.
  - Clips helper: upload a `timeline_main` JSON artifact when `input_spec.vod_url` is present (no ffmpeg required).

## Environment variables
- `API_BASE_URL` (default `http://localhost:3000`)
- `WORKER_TOKEN` (optional; if missing the script registers a new worker)
- `SUPPORTED_CAPABILITY_TAGS` (CSV, default `browser,http,screenshot,llm_summarize`; enable `ffmpeg` only if the runtime has ffmpeg)
- `PREFER_CAPABILITY_TAG` (optional; only claim jobs that include this tag)
- `MIN_PAYOUT_CENTS` (optional; skip jobs below this)
- `UNIVERSAL_WORKER_CANARY_PERCENT` (0..100, default `100`) – deterministically claim only a % of jobs (hash(jobId))
- `ONCE` (`true|false`, default `false`) – exit after one successful submit
- `WAIT_FOR_DONE` (`true|false`, default `false`) – poll `/api/jobs/:jobId` until `status=done`
- Optional (arXiv jobs): `LLM_ARXIV_ENABLED=true` + `LLM_BIN=llm` to generate real arXiv references via `llm-arxiv`

## Run locally
1) Start API + workers (in separate terminals):
   - `npm run dev`
   - `npm run worker:outbox`
   - `npm run worker:verification`
   - `npm run worker:payout`
2) Run the universal worker:
   - `npm run worker:universal`

## Notes
- For **S3+async scanning** deployments, the universal worker should wait for artifacts to reach `scanned` before submitting,
  or the server should be configured to allow “submit-before-scan” (future enhancement).
- Never put secrets in `task_descriptor`. The API rejects obvious secret keys, and production should treat descriptors as public metadata.
