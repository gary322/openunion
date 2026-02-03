#!/usr/bin/env bash
set -euo pipefail

# Fast, deterministic secret checks for tracked files only (no network, no external deps).
# This is intentionally conservative: it should catch common accidental commits like:
# - AWS access keys
# - GitHub tokens
# - Stripe live keys
# - Private keys
#
# It prints file names only (never secret content).

fail=0

die() {
  echo "[secret_scan] ERROR: $*" >&2
  exit 1
}

note() {
  echo "[secret_scan] $*"
}

check_not_tracked() {
  local path="$1"
  if git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    die "$path is tracked by git. Remove it from the index and rotate any exposed secrets."
  fi
}

scan_pattern() {
  local label="$1"
  local pattern="$2"

  # -I: ignore binary
  # -l: files-with-matches (do not print matching lines)
  # -E: extended regex
  local matches
  matches="$(git grep -I -l -E -e "$pattern" -- . || true)"
  if [[ -n "$matches" ]]; then
    fail=1
    echo "[secret_scan] FOUND ($label):"
    echo "$matches" | sed 's/^/  - /'
  else
    note "OK ($label)"
  fi
}

note "checking for forbidden tracked files..."
check_not_tracked ".env"
check_not_tracked ".env.local"
check_not_tracked "infra/terraform/terraform.tfstate"
check_not_tracked "infra/terraform/terraform.tfstate.backup"

note "scanning tracked files for common secret patterns..."

# AWS access key ids
scan_pattern "aws_access_key_id" 'AKIA[0-9A-Z]{16}'
scan_pattern "aws_session_access_key_id" 'ASIA[0-9A-Z]{16}'

# Private keys (PEM/OpenSSH)
scan_pattern "private_key_pem" '-----BEGIN[[:space:]]+([A-Z0-9]+[[:space:]]+)?PRIVATE[[:space:]]+KEY-----'
scan_pattern "openssh_private_key" '-----BEGIN[[:space:]]+OPENSSH[[:space:]]+PRIVATE[[:space:]]+KEY-----'

# GitHub tokens
scan_pattern "github_token_classic" 'gh[pousr]_[A-Za-z0-9]{20,}'
scan_pattern "github_pat" 'github_pat_[A-Za-z0-9_]{20,}'

# Stripe
scan_pattern "stripe_live_secret" 'sk_live_[A-Za-z0-9]{20,}'
scan_pattern "stripe_webhook_secret" 'whsec_[A-Za-z0-9]{20,}'

# Slack
scan_pattern "slack_token" 'xox[baprs]-[A-Za-z0-9-]{10,}'

if [[ "$fail" != "0" ]]; then
  die "potential secrets detected in tracked files (see list above)"
fi

note "OK (no secrets detected in tracked files)"
