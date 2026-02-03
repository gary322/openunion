#!/usr/bin/env bash
set -euo pipefail

# One-time history audit for common secrets. This script intentionally prints:
# - counts
# - commit SHAs (no file contents)
# It does NOT print matched lines.
#
# Output: docs/security/secret-scan-report-YYYY-MM-DD.md

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

DATE_STR="$(date +%F)"
OUT_DIR="docs/security"
OUT_FILE="${OUT_DIR}/secret-scan-report-${DATE_STR}.md"

mkdir -p "$OUT_DIR"

count_commits_for_regex() {
  local regex="$1"
  # Using -G searches diffs across history for regex hits (introduction/removal).
  git log --all -G"$regex" --pretty=format:%H | sort -u | wc -l | tr -d ' '
}

list_commits_for_regex() {
  local regex="$1"
  local max="${2:-20}"
  git log --all -G"$regex" --pretty=format:%H | sort -u | head -n "$max"
}

count_commits_for_path() {
  local path="$1"
  git log --all --pretty=format:%H -- "$path" | sort -u | wc -l | tr -d ' '
}

write_section() {
  local label="$1"
  local regex="$2"
  local c
  c="$(count_commits_for_regex "$regex")"
  {
    echo "## ${label}"
    echo ""
    echo "- Regex: \`${regex}\`"
    echo "- Matching commits: \`${c}\`"
    if [[ "$c" != "0" ]]; then
      echo "- Sample commits:"
      echo ""
      list_commits_for_regex "$regex" 20 | sed 's/^/  - /'
    fi
    echo ""
  } >>"$OUT_FILE"
}

cat >"$OUT_FILE" <<EOF
# Secret Scan Report (${DATE_STR})

This is an automated, no-content leak secret audit:
- **Tracked files scan** is enforced in CI via \`scripts/ci/secret_scan.sh\`.
- **History scan** below uses \`git log -G\` (diff-based) so it will catch secrets that were introduced and later removed.

If any section shows \`Matching commits > 0\`, treat it as a potential incident:
- Rotate credentials immediately
- Consider purging history if secrets were real and long-lived
EOF

{
  echo ""
  echo "## File history checks"
  echo ""
  echo "- Commits touching \`.env\`: \`$(count_commits_for_path ".env")\` (should be 0)"
  echo "- Commits touching \`infra/terraform/terraform.tfstate\`: \`$(count_commits_for_path "infra/terraform/terraform.tfstate")\` (should be 0)"
  echo "- Commits touching \`var/\`: \`$(git log --all --pretty=format:%H -- var 2>/dev/null | sort -u | wc -l | tr -d ' ')\` (should be 0)"
  echo ""
} >>"$OUT_FILE"

write_section "AWS access key id" "AKIA[0-9A-Z]{16}"
write_section "AWS session key id" "ASIA[0-9A-Z]{16}"
write_section "Private key blocks" "BEGIN[[:space:]]+([A-Z0-9]+[[:space:]]+)?PRIVATE[[:space:]]+KEY"
write_section "GitHub tokens" "gh[pousr]_[A-Za-z0-9]{20,}"
write_section "GitHub fine-grained PAT" "github_pat_[A-Za-z0-9_]{20,}"
write_section "Stripe live key" "sk_live_[A-Za-z0-9]{20,}"
write_section "Stripe webhook secret" "whsec_[A-Za-z0-9]{20,}"
write_section "Slack token" "xox[baprs]-[A-Za-z0-9-]{10,}"

echo "[history_secret_audit] wrote ${OUT_FILE}"

