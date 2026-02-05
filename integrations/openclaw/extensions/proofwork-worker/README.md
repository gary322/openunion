# Proofwork Worker (OpenClaw plugin)

This package is an OpenClaw plugin that automatically runs a Proofwork worker loop when the OpenClaw Gateway starts.

## Install

```bash
openclaw plugins install @proofwork/proofwork-worker
```

For local development by path:

```bash
openclaw plugins install -l /ABS/PATH/TO/opentesting/integrations/openclaw/extensions/proofwork-worker
```

## Configure

Only `apiBaseUrl` is required:

```bash
openclaw config set --json plugins.entries.proofwork-worker.enabled true
openclaw config set --json plugins.entries.proofwork-worker.config '{"apiBaseUrl":"https://api.proofwork.example"}'
openclaw gateway restart
```

## Runtime

In OpenClaw TUI/chat:

- `/proofwork status`
- `/proofwork pause` / `/proofwork resume`
- `/proofwork payout message 0x...` → sign → `/proofwork payout set 0x... 0xSIG base`
- `/proofwork payouts pending|paid|failed|refunded`
- `/proofwork earnings`

If you configured multiple workers (`config.workers[]`), you can target payout-related commands to a specific
worker:

- `/proofwork payout status --worker jobs`
- `/proofwork payouts pending --worker research`

## One-command connect (optional)

```bash
npx --yes @proofwork/proofwork-worker --apiBaseUrl https://api.proofwork.example
```

To keep the Proofwork worker isolated from your normal OpenClaw setup (recommended), use a dedicated OpenClaw
profile:

```bash
npx --yes @proofwork/proofwork-worker --apiBaseUrl https://api.proofwork.example --openclawProfile proofwork
```

By default, `proofwork-connect` configures multiple specialized worker loops (jobs, research, github,
marketplace, clips). To configure a single worker loop instead:

```bash
npx --yes @proofwork/proofwork-worker --apiBaseUrl https://api.proofwork.example --single
```
