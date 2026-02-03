#!/usr/bin/env bash
set -euo pipefail

# GitHub/AWS deployment helper:
# - Registers new ECS task definition revisions with updated container images.
# - Runs the one-off migrate task before deploying services (unless SKIP_MIGRATIONS=true).
#
# Inputs (env vars):
# - ENVIRONMENT: staging|production|prod (default: staging)
# - APP_IMAGE_URI: required (ECR image URI for app/api/workers)
# - VERIFIER_IMAGE_URI: required (ECR image URI for verifier-gateway)
# - AWS_REGION: default us-east-1
# - SKIP_MIGRATIONS: true|false (default false)
#
# Optional overrides:
# - CLUSTER, API_SERVICE, VERIFIER_SERVICE, WORKER_SERVICES, MIGRATE_TASK_FAMILY

need_bin() {
  local b="$1"
  if ! command -v "$b" >/dev/null 2>&1; then
    echo "[deploy] missing dependency: $b" >&2
    exit 1
  fi
}

need_bin aws
need_bin jq

AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION

ENVIRONMENT="${ENVIRONMENT:-staging}"
if [[ "$ENVIRONMENT" == "prod" ]]; then
  ENVIRONMENT="production"
fi

case "$ENVIRONMENT" in
  staging)
    PREFIX="proofwork-staging"
    ;;
  production)
    PREFIX="proofwork-prod"
    ;;
  *)
    echo "[deploy] invalid ENVIRONMENT=$ENVIRONMENT (expected staging|production|prod)" >&2
    exit 1
    ;;
esac

APP_IMAGE_URI="${APP_IMAGE_URI:-}"
VERIFIER_IMAGE_URI="${VERIFIER_IMAGE_URI:-}"
if [[ -z "$APP_IMAGE_URI" ]]; then
  echo "[deploy] APP_IMAGE_URI is required" >&2
  exit 1
fi
if [[ -z "$VERIFIER_IMAGE_URI" ]]; then
  echo "[deploy] VERIFIER_IMAGE_URI is required" >&2
  exit 1
fi

CLUSTER="${CLUSTER:-${PREFIX}-cluster}"
API_SERVICE="${API_SERVICE:-${PREFIX}-api}"
VERIFIER_SERVICE="${VERIFIER_SERVICE:-${PREFIX}-verifier-gateway}"
MIGRATE_TASK_FAMILY="${MIGRATE_TASK_FAMILY:-${PREFIX}-migrate}"
WORKER_SERVICES="${WORKER_SERVICES:-${PREFIX}-outbox,${PREFIX}-verification,${PREFIX}-payout,${PREFIX}-scanner,${PREFIX}-retention}"

SKIP_MIGRATIONS="${SKIP_MIGRATIONS:-false}"

log() {
  echo "[deploy] $*"
}

render_new_taskdef() {
  local task_def_arn="$1"
  local image_uri="$2"

  aws ecs describe-task-definition \
    --task-definition "$task_def_arn" \
    --query taskDefinition \
    --output json \
  | jq --arg IMAGE "$image_uri" \
      'del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy)
       | .containerDefinitions |= map(.image=$IMAGE)'
}

deploy_service() {
  local service="$1"
  local image_uri="$2"

  log "service=$service: resolving current task definition..."
  local current_td
  current_td="$(aws ecs describe-services --cluster "$CLUSTER" --services "$service" --query 'services[0].taskDefinition' --output text)"
  if [[ -z "$current_td" || "$current_td" == "None" ]]; then
    echo "[deploy] failed to resolve current task definition for service=$service" >&2
    exit 1
  fi

  log "service=$service: registering new task definition with image=$image_uri"
  local new_td_json
  new_td_json="$(render_new_taskdef "$current_td" "$image_uri")"
  local new_td_arn
  new_td_arn="$(aws ecs register-task-definition --cli-input-json "$new_td_json" --query 'taskDefinition.taskDefinitionArn' --output text)"
  if [[ -z "$new_td_arn" || "$new_td_arn" == "None" ]]; then
    echo "[deploy] register-task-definition returned empty arn for service=$service" >&2
    exit 1
  fi

  log "service=$service: updating ECS service to taskDefinition=$new_td_arn"
  aws ecs update-service --cluster "$CLUSTER" --service "$service" --task-definition "$new_td_arn" >/dev/null
}

run_migrations() {
  local skip
  skip="$(printf '%s' "${SKIP_MIGRATIONS}" | tr '[:upper:]' '[:lower:]')"
  if [[ "$skip" == "true" || "$skip" == "1" ]]; then
    log "SKIP_MIGRATIONS=true; skipping migrate task"
    return
  fi

  log "resolving network config from API service ($API_SERVICE)..."
  local awsvpc_cfg
  awsvpc_cfg="$(aws ecs describe-services --cluster "$CLUSTER" --services "$API_SERVICE" --query 'services[0].networkConfiguration.awsvpcConfiguration' --output json)"
  if [[ -z "$awsvpc_cfg" || "$awsvpc_cfg" == "null" ]]; then
    echo "[deploy] missing network configuration for API service; cannot run migrate task" >&2
    exit 1
  fi
  local net
  net="$(jq -c '{awsvpcConfiguration: .}' <<<"$awsvpc_cfg")"

  log "finding latest migrate task definition (family=${MIGRATE_TASK_FAMILY})..."
  local migrate_td
  migrate_td="$(aws ecs list-task-definitions --family-prefix "$MIGRATE_TASK_FAMILY" --sort DESC --max-items 1 --query 'taskDefinitionArns[0]' --output text)"
  if [[ -z "$migrate_td" || "$migrate_td" == "None" ]]; then
    echo "[deploy] migrate task definition not found for family=${MIGRATE_TASK_FAMILY}" >&2
    exit 1
  fi

  # Ensure migrations run from the *new* app image (so new SQL files are present in the container).
  log "registering migrate task definition revision with new app image..."
  local migrate_td_json
  migrate_td_json="$(render_new_taskdef "$migrate_td" "$APP_IMAGE_URI")"
  local migrate_td_new
  migrate_td_new="$(aws ecs register-task-definition --cli-input-json "$migrate_td_json" --query 'taskDefinition.taskDefinitionArn' --output text)"
  if [[ -z "$migrate_td_new" || "$migrate_td_new" == "None" ]]; then
    echo "[deploy] failed to register migrate task definition revision" >&2
    exit 1
  fi

  log "running migrate task ($migrate_td_new)..."
  local task_arn
  task_arn="$(aws ecs run-task --cluster "$CLUSTER" --launch-type FARGATE --task-definition "$migrate_td_new" --network-configuration "$net" --count 1 --query 'tasks[0].taskArn' --output text)"
  if [[ -z "$task_arn" || "$task_arn" == "None" ]]; then
    echo "[deploy] run-task returned empty taskArn for migrate" >&2
    exit 1
  fi

  log "waiting for migrate task to stop..."
  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$task_arn"

  local exit_code
  exit_code="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_arn" --query 'tasks[0].containers[0].exitCode' --output text)"
  if [[ "$exit_code" != "0" ]]; then
    local reason
    reason="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_arn" --query 'tasks[0].stoppedReason' --output text)"
    echo "[deploy] migrate task failed (exit_code=$exit_code) reason=$reason taskArn=$task_arn" >&2
    exit 1
  fi

  log "migrate task OK"
}

main() {
  log "env=$ENVIRONMENT cluster=$CLUSTER"

  run_migrations

  # Deploy API/workers (shared image)
  deploy_service "$API_SERVICE" "$APP_IMAGE_URI"
  IFS=',' read -r -a workers <<<"$WORKER_SERVICES"
  for svc in "${workers[@]}"; do
    svc="$(echo "$svc" | xargs)"
    [[ -z "$svc" ]] && continue
    deploy_service "$svc" "$APP_IMAGE_URI"
  done

  # Deploy verifier gateway (separate image repo)
  deploy_service "$VERIFIER_SERVICE" "$VERIFIER_IMAGE_URI"

  log "waiting for services to become stable..."
  local all_services=("$API_SERVICE" "$VERIFIER_SERVICE")
  for svc in "${workers[@]}"; do
    svc="$(echo "$svc" | xargs)"
    [[ -z "$svc" ]] && continue
    all_services+=("$svc")
  done
  aws ecs wait services-stable --cluster "$CLUSTER" --services "${all_services[@]}"

  log "deploy OK"
}

main "$@"
