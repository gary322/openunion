# Secret Scan Report (2026-02-03)

This is an automated, no-content leak secret audit:
- **Tracked files scan** is enforced in CI via `scripts/ci/secret_scan.sh`.
- **History scan** below uses `git log -G` (diff-based) so it will catch secrets that were introduced and later removed.

If any section shows `Matching commits > 0`, treat it as a potential incident:
- Rotate credentials immediately
- Consider purging history if secrets were real and long-lived

## File history checks

- Commits touching `.env`: `0` (should be 0)
- Commits touching `infra/terraform/terraform.tfstate`: `0` (should be 0)
- Commits touching `var/`: `0` (should be 0)

## AWS access key id

- Regex: `AKIA[0-9A-Z]{16}`
- Matching commits: `0`

## AWS session key id

- Regex: `ASIA[0-9A-Z]{16}`
- Matching commits: `0`

## Private key blocks

- Regex: `BEGIN[[:space:]]+([A-Z0-9]+[[:space:]]+)?PRIVATE[[:space:]]+KEY`
- Matching commits: `0`

## GitHub tokens

- Regex: `gh[pousr]_[A-Za-z0-9]{20,}`
- Matching commits: `0`

## GitHub fine-grained PAT

- Regex: `github_pat_[A-Za-z0-9_]{20,}`
- Matching commits: `0`

## Stripe live key

- Regex: `sk_live_[A-Za-z0-9]{20,}`
- Matching commits: `0`

## Stripe webhook secret

- Regex: `whsec_[A-Za-z0-9]{20,}`
- Matching commits: `0`

## Slack token

- Regex: `xox[baprs]-[A-Za-z0-9-]{10,}`
- Matching commits: `0`

