# Releasing the OpenClaw Proofwork Worker plugin (npm)

This repo contains a self-contained OpenClaw plugin package at:
- `integrations/openclaw/extensions/proofwork-worker/`

Publishing it to npm enables non-dev users to install with:
```bash
openclaw plugins install @proofwork/proofwork-worker
```

## Prereqs
- You have publish access to the npm package name (default: `@proofwork/proofwork-worker`).
- GitHub repo secret `NPM_TOKEN` is set (automation), or you are logged in locally (`npm login`) (manual).

## Before you publish
1) Bump versions (keep them in sync):
   - `integrations/openclaw/extensions/proofwork-worker/package.json`
   - `integrations/openclaw/extensions/proofwork-worker/openclaw.plugin.json`
   - `integrations/openclaw/plugins/proofwork-worker/openclaw.plugin.json` (dev plugin)

2) Sync the bundled worker script:
```bash
node integrations/openclaw/extensions/proofwork-worker/scripts/sync_assets.mjs
node integrations/openclaw/extensions/proofwork-worker/scripts/sync_assets.mjs --check
```

3) Run tests:
```bash
npm test
npm run build
```

## Publish (automation)
Push a tag matching:
- `proofwork-worker-vX.Y.Z`

The workflow `.github/workflows/publish_openclaw_plugin.yml` will:
- run tests + typecheck
- verify assets are synced
- `npm publish` from `integrations/openclaw/extensions/proofwork-worker/`

## Publish (manual)
```bash
cd integrations/openclaw/extensions/proofwork-worker
npm publish
```

## Smoke (recommended)
After publishing, validate install flows:
- `openclaw plugins install @proofwork/proofwork-worker`
- `npx --yes @proofwork/proofwork-worker --apiBaseUrl https://api.proofwork.example`

And for a full end-to-end local run (requires Docker):
```bash
bash scripts/smoke_openclaw_plugin.sh
```

