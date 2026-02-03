#!/usr/bin/env bash
set -euo pipefail

# This repo's AWS OIDC trust policy relies on GitHub's job "environment" claim:
#   repo:<owner>/<repo>:environment:staging
#   repo:<owner>/<repo>:environment:production
#
# If someone edits .github/workflows/deploy.yml and changes these environment names,
# deployments will fail (or, worse, assume the wrong role).

FILE=".github/workflows/deploy.yml"

if [[ ! -f "$FILE" ]]; then
  echo "[check_deploy_workflow_envs] missing $FILE" >&2
  exit 1
fi

if ! grep -qE '^[[:space:]]*environment:[[:space:]]*staging[[:space:]]*$' "$FILE"; then
  echo "[check_deploy_workflow_envs] ERROR: deploy workflow must include 'environment: staging' (OIDC trust depends on it)" >&2
  exit 1
fi

if ! grep -qE '^[[:space:]]*environment:[[:space:]]*production[[:space:]]*$' "$FILE"; then
  echo "[check_deploy_workflow_envs] ERROR: deploy workflow must include 'environment: production' (OIDC trust depends on it)" >&2
  exit 1
fi

echo "[check_deploy_workflow_envs] OK"

