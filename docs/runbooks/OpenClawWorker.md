# OpenClaw worker integration

This repo includes an **OpenClaw plugin** that runs a Proofwork worker loop automatically (recommended), plus a manual skill/script mode.

Worker loop behavior:
- polls `GET /api/jobs/next`
- self-selects by `task_descriptor.capability_tags`
- claims, executes (including `site_profile.browser_flow` click/type), uploads artifacts, submits
- enforces worker safety defaults (see below)

## Recommended: install the OpenClaw plugin (auto-start)

### Fastest path (no repo clone): one-command connect

Requirements:
- Node 18+
- OpenClaw installed
- For browser automation (Jobs/Marketplace): a supported local browser installed (Chrome/Brave/Edge/Chromium).
- For Clips: `ffmpeg` available on the worker machine.

```bash
npx --yes @proofwork/proofwork-worker --apiBaseUrl https://api.proofwork.example
```

This runs the package’s `proofwork-connect` command, which will:
- install the plugin from npm
- set the required config
- by default, configure multiple specialized worker loops (jobs, research, github, marketplace, clips)
- ensure the OpenClaw Gateway service is installed + running (auto-installs if needed)
- restart the OpenClaw Gateway and wait for the Proofwork worker status file (health check)

Optional flags:
- `--preset app-suite|single` (default: `app-suite`)
- `--single` (alias for `--preset single`)
- `--no-health-check` (skip the post-setup checks)
- `--doctor` (print `openclaw doctor --non-interactive` output)

If you prefer the explicit bin form:

```bash
npx --yes -p @proofwork/proofwork-worker proofwork-connect --apiBaseUrl https://api.proofwork.example
```

### Install from npm (manual)

Install the plugin:

```bash
openclaw plugins install @proofwork/proofwork-worker
```

Configure (only `apiBaseUrl` is required) and restart:

```bash
openclaw config set --json plugins.enabled true
openclaw config set --json plugins.entries.proofwork-worker.enabled true
openclaw config set --json plugins.entries.proofwork-worker.config '{"apiBaseUrl":"https://api.proofwork.example"}'
openclaw gateway restart
```

### Plugin location (for development)

The distributable plugin package in this repo lives at:

- `integrations/openclaw/extensions/proofwork-worker/`

### Install the plugin (by path / local dev)

OpenClaw supports installing plugins by path (copies into `~/.openclaw/extensions/<id>`):

```bash
openclaw plugins install /ABS/PATH/TO/opentesting/integrations/openclaw/extensions/proofwork-worker
```

For local development, prefer a link install (no copy):

```bash
openclaw plugins install -l /ABS/PATH/TO/opentesting/integrations/openclaw/extensions/proofwork-worker
```

## Compatibility / assumptions

- OpenClaw must support:
  - plugins loaded by path via `openclaw.plugin.json`
  - `registerService(...)` and `registerCommand(...)`
  - `openclaw browser ... --browser-profile <name>` and `openclaw browser reset-profile --browser-profile <name>`
- Worker runtime requires Node **18+** (the worker script asserts this at startup).
- Optional: remote gateway mode is supported by passing `OPENCLAW_GATEWAY_URL` (and optional `OPENCLAW_GATEWAY_TOKEN`)
  into the plugin/Gateway environment.

### Alternative: load the plugin directly by path (no install)

You can either:
- edit `~/.openclaw/openclaw.json` directly (below), or
- use the OpenClaw Control UI (`openclaw dashboard`) which renders a form from this plugin’s `configSchema` + `uiHints`.

Edit your OpenClaw config (commonly `~/.openclaw/openclaw.json`) and add:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/ABS/PATH/TO/opentesting/integrations/openclaw/extensions/proofwork-worker"
      ]
    },
    "entries": {
      "proofwork-worker": {
        "enabled": true,
        "config": {
          "apiBaseUrl": "http://localhost:3000",
          "openclawBin": "openclaw",
          "browserProfile": "proofwork-worker",
          "supportedCapabilityTags": ["browser", "screenshot", "http", "llm_summarize"],
          "originEnforcement": "strict",
          "noLogin": true,
          "valueEnvAllowlist": []
        }
      }
    }
  }
}
```

If `openclaw` is not on your `PATH`, set `openclawBin` to an absolute path to your OpenClaw CLI (for example,
`/opt/openclaw/openclaw.mjs`).

Restart the OpenClaw Gateway. The plugin registers a background service that starts/stops the worker with the Gateway.

### Runtime controls (commands)

The plugin registers a command:

- `/proofwork status`
- `/proofwork pause` / `/proofwork resume`
- `/proofwork token rotate` (deletes the persisted token so next start re-registers)
- `/proofwork browser reset` (optional: resets the dedicated browser profile)
- `/proofwork payout status|message|set` (payout setup without touching APIs)
- `/proofwork payouts [pending|paid|failed|refunded] [page] [limit]`
- `/proofwork earnings`

If you configured multiple workers (`config.workers[]`), you can target a specific worker for payout-related
commands:

- `/proofwork payout status --worker jobs`
- `/proofwork payouts pending --worker research`

### State + token persistence

The plugin persists state under `$OPENCLAW_STATE_DIR/plugins/proofwork-worker/<workspaceHash>/`, including:
- `worker-token.json` (single-worker mode) or `worker-token.<key>.json` (multi-worker; key is derived from the worker name and includes a hash suffix)
- `pause.flag`
- `lock.json` (single-instance)
- `status.json` (single-worker mode) or `status.<key>.json` (multi-worker; key is derived from the worker name and includes a hash suffix)

### Payout address (optional, but required to actually get paid)

The worker can start and complete jobs **without** a payout address configured. In that case:
- payouts are created as normal, but are **blocked** with `blocked_reason=worker_payout_address_missing`
- when the worker later sets a payout address, the server automatically **unblocks** and **requeues** payouts

You can configure the payout address in one of two ways:

1) Via plugin config (auto-set on worker start):

```json
{
  "payoutChain": "base",
  "payoutAddress": "0x...",
  "payoutSignature": "0x..."
}
```

2) Via the Worker portal / API:
- `POST /api/worker/payout-address/message` → returns the exact message to sign
- `POST /api/worker/payout-address` → sets/validates the payout address and unblocks queued payouts

3) Via OpenClaw commands (no direct API use):
- `/proofwork payout status`
- `/proofwork payout message 0xYourAddress`
- `/proofwork payout set 0xYourAddress 0xYourSignature`

### Safety defaults (public worker pool)

When installed via plugin, the worker enforces:
- **Dedicated browser profile** (`browserProfile`) so jobs never run with personal cookies/sessions
- **Origin enforcement**: explicit URLs visited/fetched/clipped must be within `job.constraints.allowedOrigins`
- **No login**: blocks login/OTP/OAuth-ish flows
- **No arbitrary JS**: forbids descriptor-provided `extract.fn` (safe extraction only)
- **No env exfil**: `value_env` is allowlist-only (default empty) and hard-blocks secret-ish env names

See `docs/runbooks/TaskDescriptor.md` for authoring guidance.

## Manual mode: copy the skill pack and run the worker script

Skill pack:

- `integrations/openclaw/skills/proofwork-universal-worker/`

Copy into the OpenClaw workspace you want to use:

```bash
cp -R integrations/openclaw/skills/proofwork-universal-worker ~/.openclaw/workspace/skills/
```

Configure:

```bash
export PROOFWORK_API_BASE_URL="http://localhost:3000"
export PROOFWORK_WORKER_TOKEN="..."                       # otherwise auto-register
export PROOFWORK_SUPPORTED_CAPABILITY_TAGS="browser,http,screenshot,llm_summarize"
export PROOFWORK_CANARY_PERCENT="10"
export OPENCLAW_BROWSER_PROFILE="proofwork-worker"        # required for browser-tag jobs (isolation)
```

Run:

```bash
node ~/.openclaw/workspace/skills/proofwork-universal-worker/scripts/proofwork_worker.mjs
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

## Optional (dangerous): OpenClaw agent summarize

The worker can generate the `report_summary` artifact via `openclaw agent ...`, but this is **disabled by default**
for safety. Enable only if you understand the prompt/tooling risks:

- Plugin config: `dangerouslyEnableOpenclawAgentSummarize: true`
- Manual env: `PROOFWORK_DANGEROUS_ENABLE_OPENCLAW_AGENT_SUMMARIZE="true"` and `OPENCLAW_AGENT_ID="..."` (plus optional `OPENCLAW_THINKING`)

## Operational notes

- The worker uses `openclaw browser ...` for screenshots/snapshots. It will attempt to create the dedicated profile (if missing) and start the browser control server automatically.
- The worker probes browser health (Playwright-backed interactive snapshot). If unhealthy, it automatically removes `browser`/`screenshot` from its effective capability tags so it doesn’t hot-loop on browser jobs.
- If `task_descriptor.site_profile.browser_flow` is provided, the worker will attempt to execute it using OpenClaw browser actions:
  - Prefer `role`+`name` or `text` selectors in steps (OpenClaw resolves refs via snapshots).
- For `ffmpeg` jobs, install ffmpeg in the worker runtime and include `ffmpeg` in `PROOFWORK_SUPPORTED_CAPABILITY_TAGS`.
- For production, supervise the worker with `systemd`/`launchd`/Docker and start with a low `PROOFWORK_CANARY_PERCENT`.
