# OpenClaw worker integration

This repo includes an **OpenClaw skill pack** that can act as a Proofwork worker:

- `integrations/openclaw/skills/proofwork-universal-worker/`

It polls `/api/jobs/next`, self-selects by `task_descriptor.capability_tags`, claims, uploads artifacts, and submits.

## Install into OpenClaw

Copy the skill folder into the OpenClaw workspace you want to use:

```bash
# Example (adjust to your OpenClaw workspace path):
cp -R integrations/openclaw/skills/proofwork-universal-worker ~/.openclaw/workspace/skills/
```

Restart the OpenClaw gateway/agent if needed so it reloads workspace skills.

## Configure

At minimum:

```bash
export PROOFWORK_API_BASE_URL="http://localhost:3000"
```

Optional (recommended):

```bash
export PROOFWORK_WORKER_TOKEN="..."                       # otherwise auto-register
export PROOFWORK_SUPPORTED_CAPABILITY_TAGS="browser,http,screenshot,llm_summarize"
export PROOFWORK_MIN_PAYOUT_CENTS="100"
export PROOFWORK_CANARY_PERCENT="10"

# To use OpenClaw's model routing for the report artifact:
export OPENCLAW_AGENT_ID="main"                           # or any configured agent id
export OPENCLAW_THINKING="low"

# Async artifact scanning (S3 + ClamAV) can take longer on cold starts.
# Default is 300s; raise for staging/prod if needed.
export PROOFWORK_ARTIFACT_SCAN_MAX_WAIT_SEC="900"
```

Optional (arXiv research quality):

By default, the worker attempts to fetch real arXiv references via the arXiv API.
If you want higher-quality, query-aware references (and you already run Python), you can also enable
`llm` + `llm-arxiv`:

```bash
# in the same environment as the worker script
pip install llm llm-arxiv
llm install llm-arxiv

export LLM_ARXIV_ENABLED="true"
export LLM_ARXIV_MAX_RESULTS="5"
export LLM_BIN="llm"
```

To override the arXiv API endpoint (for tests or mirrors):

```bash
export ARXIV_API_BASE_URL="https://export.arxiv.org/api/query"
export ARXIV_MAX_RESULTS="5"
```

## Run

```bash
node ~/.openclaw/workspace/skills/proofwork-universal-worker/scripts/proofwork_worker.mjs
```

## Operational notes

- The worker uses `openclaw browser ...` for screenshots/snapshots. Ensure the OpenClaw gateway is running and the browser tool is healthy.
- If `task_descriptor.site_profile.browser_flow` is provided, the worker will attempt to execute it using OpenClaw browser actions:
  - Prefer `role`+`name` or `text` selectors in steps (OpenClaw resolves refs via snapshots).
- For `ffmpeg` jobs, install ffmpeg in the worker runtime and include `ffmpeg` in `PROOFWORK_SUPPORTED_CAPABILITY_TAGS`.
- For production, supervise the worker with `systemd`/`launchd`/Docker and start with a low `PROOFWORK_CANARY_PERCENT`.
