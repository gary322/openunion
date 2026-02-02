# Task Descriptor runbook

`task_descriptor` is the small, versioned JSON blob that makes jobs **discoverable** and **self-selectable** by Universal Workers.

It is stored on `bounties.task_descriptor` and copied to `jobs.task_descriptor` at publish time.

## Where it is used
- Buyer creates a bounty with `taskDescriptor` on `POST /api/bounties`.
- Worker discovers compatible work via `GET /api/jobs/next`:
  - `capability_tags=<csv>` enforces **subset matching** (job tags must be a subset of the worker’s supported tags).
  - `capability_tag=<tag>` is a convenience filter (job must include this tag).
  - `min_payout_cents=<int>` skips low-value jobs.
- Verifier gateway can enforce output requirements via `output_spec.required_artifacts` (see below).

## Schema + validation
- Served at: `/contracts/task_descriptor.schema.json`
- Server-side validation:
  - `schema_version` must be `v1`
  - `capability_tags[]` allowlist: `browser`, `http`, `ffmpeg`, `llm_summarize`, `screenshot`
  - JSON size is capped (`TASK_DESCRIPTOR_MAX_BYTES`, default 16000 bytes)
  - JSON depth is capped (`TASK_DESCRIPTOR_MAX_DEPTH`, default 6)
  - “Likely secret” keys are rejected (keys containing `token`, `secret`, `password`)

Feature flag:
- `ENABLE_TASK_DESCRIPTOR=false` disables descriptor intake/exposure (rollback tool).

## Recommended conventions (v1)
Keep `input_spec` and `output_spec` small and declarative. Do not embed credentials.

## Optional: site_profile.browser_flow (browser actions)

If you want the Universal Worker to do more than a screenshot (e.g. **click/type/wait/extract**), you can
provide an optional `site_profile.browser_flow` with step descriptors.

This is intentionally lightweight and best-effort (the platform does not strictly validate the structure),
but it is bounded by `TASK_DESCRIPTOR_MAX_BYTES` and `TASK_DESCRIPTOR_MAX_DEPTH`.

### Supported step ops (v0)
- `navigate|goto`: `{ op, url, timeout_ms? }`
- `wait`: `{ op:"wait", ms? | selector? | text? | url?, timeout_ms? }`
- `click`: `{ op:"click", selector? | role?+name? | text? | ref?, timeout_ms? }`
- `fill|type`: `{ op, selector? | role?+name? | text? | ref?, value? | value_env?, timeout_ms? }`
- `press`: `{ op:"press", key }`
- `screenshot`: `{ op:"screenshot", label?, full_page? }`
- `extract`: `{ op:"extract", key, kind? ("text"|"attribute"|"value"|"html"), selector? | role?+name? | text? | ref?, attribute? }`

Notes:
- Playwright worker supports `selector`, `role+name`, and `text` locators.
- OpenClaw worker prefers `role+name`/`text` (it resolves `ref` via snapshots); CSS selectors are not used for actions there.
- For `value_env`, the worker reads from its environment (do not put secrets in descriptors).

### Example: search flow + extraction

```json
{
  "schema_version": "v1",
  "type": "marketplace_search",
  "capability_tags": ["browser", "screenshot", "llm_summarize"],
  "input_spec": { "url": "https://example.com" },
  "site_profile": {
    "browser_flow": {
      "steps": [
        { "op": "fill", "selector": "#q", "value": "laptop" },
        { "op": "click", "selector": "#search" },
        { "op": "wait", "text": "Results" },
        { "op": "extract", "key": "status_text", "kind": "text", "selector": "#status" },
        { "op": "screenshot", "label": "after_search", "full_page": true }
      ]
    }
  },
  "output_spec": {
    "required_artifacts": [
      { "kind": "screenshot", "count": 1 },
      { "kind": "log", "count": 1, "label_prefix": "report" }
    ]
  }
}
```

### Output requirements (optional but recommended)
The verifier gateway supports a simple deterministic contract:

```json
{
  "output_spec": {
    "required_artifacts": [
      { "kind": "video", "count": 1, "label_prefix": "clip" },
      { "kind": "log", "count": 1, "label_prefix": "report" }
    ]
  }
}
```

Each entry requires that `submission.artifactIndex` contains at least `count` artifacts matching:
- `kind` (exact)
- optional `label` (exact)
- optional `label_prefix` (prefix match)

If missing, the verifier gateway fails the submission deterministically.

### JSON artifact conventions (optional)
If you require `kind=other` artifacts with specific `label_prefix` values, the verifier gateway performs basic, deterministic content checks by downloading the artifact via `/api/artifacts/:id/download`:
- `label_prefix=timeline*`: JSON must include `clips[]` with valid `start_sec/end_sec` bounds
- `label_prefix=results*`: JSON must include `items[]` (non-empty)
- `label_prefix=deals*`: JSON must include `deals[]` (non-empty)
- `label_prefix=rows*`: JSON must include `rows[]` (non-empty)
- `label_prefix=repos*`: JSON must include `repos[]` (non-empty)
- `label_prefix=references*`: JSON must include `references[]` (non-empty)

## Descriptor templates (examples)

### 1) Clips/highlights
```json
{
  "schema_version": "v1",
  "type": "clips",
  "capability_tags": ["ffmpeg", "llm_summarize", "screenshot"],
  "input_spec": { "vod_url": "https://..." , "rules": "highlights around spikes" },
  "output_spec": { "required_artifacts": [
    { "kind": "video", "count": 1, "label_prefix": "clip" },
    { "kind": "other", "count": 1, "label_prefix": "timeline" },
    { "kind": "log", "count": 1, "label_prefix": "report" }
  ] },
  "freshness_sla_sec": 3600
}
```

### 2) Marketplace/drops
```json
{
  "schema_version": "v1",
  "type": "drops",
  "capability_tags": ["browser", "screenshot"],
  "input_spec": { "url": "https://...", "max_price": 100 },
  "output_spec": { "required_artifacts": [
    { "kind": "screenshot", "count": 1 },
    { "kind": "other", "count": 1, "label_prefix": "results" }
  ] },
  "freshness_sla_sec": 600,
  "site_profile": { "selectors": { "price": ".price", "availability": "#stock" } }
}
```

### 3) ArXiv idea → research plan
```json
{
  "schema_version": "v1",
  "type": "arxiv_research_plan",
  "capability_tags": ["http", "llm_summarize"],
  "input_spec": { "idea": "..." },
  "output_spec": { "required_artifacts": [
    { "kind": "log", "count": 1, "label_prefix": "report" },
    { "kind": "other", "count": 1, "label_prefix": "references" }
  ] }
}
```

Worker note:
- The reference workers can optionally use `llm-arxiv` to generate real `references[]` for arXiv jobs.
  See `docs/runbooks/OpenClawWorker.md` (OpenClaw worker) for setup.

## Freshness / stale jobs
If `freshness_sla_sec` is set:
- `GET /api/jobs/next` will **not** offer the job after the SLA window.
- `POST /api/jobs/:jobId/claim` returns `409 stale_job` if the job is already stale.
