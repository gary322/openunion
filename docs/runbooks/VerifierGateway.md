# Verifier gateway runbook

### What it does
- Accepts `/run` requests from the verification worker.
- Executes a **deterministic Playwright** run against `submission.manifest.finalUrl`.
- Enforces **allowed origin** policy from `jobSpec.constraints.allowedOrigins` by blocking cross-origin requests.
- Optionally enforces `task_descriptor.output_spec.required_artifacts` (deterministic policy gate).
- Optionally validates **descriptor-bound artifacts** by downloading internal artifacts via `/api/artifacts/:id/download`:
  - `video` artifacts: MP4 container sniff (`ftyp`)
  - `timeline` artifacts (`kind=other` + `label_prefix=timeline`): JSON structure + clip bounds
- Uploads evidence artifacts to the API:
  - screenshot (`image/png`)
  - console log (`text/plain`)
  - HAR (`application/octet-stream`)

### Key env vars
- `API_BASE_URL`: internal API base URL (e.g. `http://api.<namespace>.local:3000` in ECS service discovery)
- `VERIFIER_TOKEN`: verifier token preimage for `/api/verifier/uploads/*`
- `VERIFIER_PLAYWRIGHT_TIMEOUT_MS`: navigation timeout (default 15000ms)
- `VERIFIER_MAX_ARTIFACT_BYTES`: max bytes to download for descriptor-bound validation (default 25000000)
- `VERIFIER_ARTIFACT_DOWNLOAD_TIMEOUT_MS`: download timeout for descriptor-bound validation (default 15000)

### Failure modes
- **Playwright launch failures**: usually missing browser deps/image; fix by using the Playwright-based gateway image (`services/verifier-gateway/Dockerfile`).
- **Origin blocks break pages**: expected for pages that depend on third-party resources.
  - Mitigation: allowlist the required origins, or capture deterministic fixtures for verification.
- **Missing required artifacts**: if `output_spec.required_artifacts` is set, the gateway fails fast with `missing_required_artifacts:...`.
- **Evidence upload failures**: the gateway returns a verdict, but evidence may be missing.
  - Check API connectivity, verifier token, and `/api/verifier/uploads/*` responses.
