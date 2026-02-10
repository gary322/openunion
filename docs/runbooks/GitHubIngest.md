# GitHub ingestion (always-on)

This repo supports a GitHub ingestion worker (`workers/github-ingest-runner.ts`) that writes:
- `github_events_raw` (append-only, idempotent by event_id)
- `github_repos` (normalized repo snapshots)
- `github_sources` (cursor + health/status)

It is designed to support:
- near-real-time signals from GitHub’s public Events API
- completeness/backfill from GH Archive hourly dumps

## What it ingests

Default mode is `hybrid`:
- `events_api`: polls `https://api.github.com/events` (rate-limited; best-effort)
- `gh_archive`: polls `https://data.gharchive.org/<YYYY-MM-DD-H>.json.gz` (hourly; backfill)

## Enable on AWS ECS (staging or production)

This creates/updates an ECS service `${prefix}-github-ingest` by cloning the `${prefix}-retention` service’s network + IAM config.

Staging:

```bash
npm run ops:github:ingest:enable -- --env staging
```

Production:

```bash
npm run ops:github:ingest:enable -- --env production
```

Notes:
- The service runs continuously with desiredCount=1.
- The worker prunes `github_events_raw` by default (TTL 14 days, batch deletes).
- If you want higher ingest volume or better API rate limits, set `GITHUB_TOKEN` in the worker task definition (not required for GH Archive).

## Health checks

- Ingest worker health is exposed via its internal health server (ECS-only).
- API metrics (`GET /health/metrics`) expose:
  - `proofwork_github_sources{status=...}`
  - `proofwork_github_last_success_age_seconds`

## Troubleshooting

- No GitHub sources/rows appear:
  - Check ECS service logs for `github-ingest` (likely misconfigured env or DB auth).
- Rate limit / API failures:
  - Events API is best-effort. GH Archive backfill should still progress hourly.
  - Add a `GITHUB_TOKEN` to raise GitHub API limits.

