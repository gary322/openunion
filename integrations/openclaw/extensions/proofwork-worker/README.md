# Proofwork Worker (OpenClaw plugin)

This package is an OpenClaw plugin that automatically runs a Proofwork worker loop when the OpenClaw Gateway starts.

## Install

```bash
openclaw plugins install /ABS/PATH/TO/openunion/integrations/openclaw/extensions/proofwork-worker
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

## One-command connect (optional)

```bash
curl -fsSL https://raw.githubusercontent.com/gary322/openunion/main/scripts/openclaw_proofwork_connect.mjs -o /tmp/proofwork_connect.mjs
node /tmp/proofwork_connect.mjs --apiBaseUrl https://api.proofwork.example
```
