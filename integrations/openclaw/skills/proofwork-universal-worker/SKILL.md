---
name: proofwork-universal-worker
description: Poll Proofwork (opentesting) jobs, self-select by task_descriptor capability tags, execute, upload artifacts, and submit.
homepage: https://github.com/openclaw/openclaw
metadata:
  {
    "openclaw":
      {
        "emoji": "🧰",
        "requires":
          {
            "bins": ["node", "openclaw"],
            "env": ["PROOFWORK_API_BASE_URL"],
          },
        "primaryEnv": "PROOFWORK_API_BASE_URL",
      },
  }
---

# Proofwork Universal Worker (OpenClaw)

This skill turns an OpenClaw install into a **Proofwork / opentesting worker**:

- Polls Proofwork `/api/jobs/next`
- Filters jobs by `task_descriptor.capability_tags` (self-selection)
- Claims a compatible job (`POST /api/jobs/:jobId/claim`)
- Executes via reusable modules (browser/http/ffmpeg/llm)
- Uploads artifacts (presigned upload flow)
- Submits (`POST /api/jobs/:jobId/submit`) with idempotency

This is meant to pair with the Proofwork "Universal Worker + task_descriptor" implementation in this repo.

## Requirements

- A running Proofwork API (local or deployed)
- OpenClaw installed and configured (Gateway running)
- Optional: `ffmpeg` if you want `capability_tags` that include `ffmpeg`

## Setup

1. Configure environment:

```bash
export PROOFWORK_API_BASE_URL="http://localhost:3000"
# Optional: provide an existing worker token, otherwise the script will auto-register:
export PROOFWORK_WORKER_TOKEN="..."

# Strongly recommended: force all browser automation onto a dedicated OpenClaw profile.
# The worker will attempt to create the profile (if missing) and start the browser control server automatically.
export OPENCLAW_BROWSER_PROFILE="proofwork-worker"

# Optional: tolerate slow S3/ClamAV async scans (default 300s)
export PROOFWORK_ARTIFACT_SCAN_MAX_WAIT_SEC="900"
```

Optional: configure payout address (Base). If you set `PROOFWORK_PAYOUT_ADDRESS` but not a signature,
the worker prints the exact message you need to sign.

```bash
export PROOFWORK_PAYOUT_CHAIN="base"
export PROOFWORK_PAYOUT_ADDRESS="0x..."
export PROOFWORK_PAYOUT_SIGNATURE="0x..."   # signature of the server-provided message
```

2. Configure capabilities this worker supports (declared once):

```bash
export PROOFWORK_SUPPORTED_CAPABILITY_TAGS="browser,http,screenshot,llm_summarize"
# Add ffmpeg only if present in the runtime:
# export PROOFWORK_SUPPORTED_CAPABILITY_TAGS="browser,http,screenshot,llm_summarize,ffmpeg"
```

3. (Optional) Canary rollout:

```bash
export PROOFWORK_CANARY_PERCENT="10"
```

4. (Optional) Better arXiv references:

By default, the worker fetches real arXiv references via the arXiv API.

You can override the API endpoint/results count (useful for tests or self-hosted mirrors):

```bash
export ARXIV_API_BASE_URL="https://export.arxiv.org/api/query"
export ARXIV_MAX_RESULTS="5"
```

If you publish `type=arxiv_*` jobs and want more query-aware references (and you already run Python),
install `llm` + `llm-arxiv` and enable:

```bash
pip install llm llm-arxiv
llm install llm-arxiv

export LLM_ARXIV_ENABLED="true"
export LLM_ARXIV_MAX_RESULTS="5"
export LLM_BIN="llm"
```

## Run

```bash
node {baseDir}/scripts/proofwork_worker.mjs
```

One-shot run (exit after one idle cycle):

```bash
ONCE=true node {baseDir}/scripts/proofwork_worker.mjs
```

## Notes (how selection works)

- The worker fetches jobs and only claims when:
  - `capability_tags ⊆ PROOFWORK_SUPPORTED_CAPABILITY_TAGS`
  - payout / freshness filters pass (if configured)
  - the canary hash admits the job (if enabled)

No per-site "skills" are required; new work is added by publishing a new `task_descriptor`.
