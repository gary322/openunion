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
# - CLAMAV_IMAGE: clamd sidecar image for the scanner service (default: clamav/clamav-debian:latest)

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

# Expose the build SHA/tag in the running containers so `/api/version` can report the deployed
# version (instead of "dev"). We default to the app image tag, which is `sha-<sha7>` in CI.
PROOFWORK_VERSION_TAG="${PROOFWORK_VERSION_TAG:-${APP_IMAGE_URI##*:}}"

CLUSTER="${CLUSTER:-${PREFIX}-cluster}"
API_SERVICE="${API_SERVICE:-${PREFIX}-api}"
VERIFIER_SERVICE="${VERIFIER_SERVICE:-${PREFIX}-verifier-gateway}"
MIGRATE_TASK_FAMILY="${MIGRATE_TASK_FAMILY:-${PREFIX}-migrate}"
WORKER_SERVICES="${WORKER_SERVICES:-${PREFIX}-outbox,${PREFIX}-verification,${PREFIX}-payout,${PREFIX}-scanner,${PREFIX}-retention,${PREFIX}-github-ingest,${PREFIX}-alarm_inbox}"
# Some services are optional and may be disabled by Terraform in certain environments
# (for example, alarm_inbox is only enabled when real alerting is configured).
OPTIONAL_SERVICES="${OPTIONAL_SERVICES:-${PREFIX}-github-ingest,${PREFIX}-alarm_inbox}"

SKIP_MIGRATIONS="${SKIP_MIGRATIONS:-false}"
CLAMAV_IMAGE="${CLAMAV_IMAGE:-clamav/clamav-debian:latest}"

log() {
  echo "[deploy] $*"
}

is_optional_service() {
  local svc="$1"
  local csv="$2"
  local IFS=','
  read -r -a items <<<"$csv"
  for it in "${items[@]}"; do
    it="$(echo "$it" | xargs)"
    [[ -z "$it" ]] && continue
    if [[ "$it" == "$svc" ]]; then
      return 0
    fi
  done
  return 1
}

WAIT_SERVICES=()

render_new_taskdef() {
  local task_def_arn="$1"
  local image_uri="$2"
  local container_name="${3:-}"

  aws ecs describe-task-definition \
    --task-definition "$task_def_arn" \
    --query taskDefinition \
    --output json \
  | jq --arg IMAGE "$image_uri" --arg NAME "$container_name" --arg VERSION "$PROOFWORK_VERSION_TAG" \
      'del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy)
       | .containerDefinitions |= (if ($NAME | length) > 0
           then map(
             if .name == $NAME then
               .image = $IMAGE
               | .environment = ((.environment // []) | map(select(.name!="PROOFWORK_VERSION")) + [{name:"PROOFWORK_VERSION",value:$VERSION}])
             else . end
           )
           else map(
             .image = $IMAGE
             | .environment = ((.environment // []) | map(select(.name!="PROOFWORK_VERSION")) + [{name:"PROOFWORK_VERSION",value:$VERSION}])
           )
         end)'
}

deploy_service() {
  local service="$1"
  local image_uri="$2"

  log "service=$service: resolving current task definition..."
  local svc_json
  svc_json="$(aws ecs describe-services --cluster "$CLUSTER" --services "$service" --query 'services[0]' --output json)"

  local svc_status
  svc_status="$(jq -r '.status // ""' <<<"$svc_json")"
  local current_td
  current_td="$(jq -r '.taskDefinition // ""' <<<"$svc_json")"

  # If Terraform disables a worker service, AWS keeps the name but the service can become INACTIVE.
  # Treat optional services as best-effort so production deploys don't fail on disabled components.
  if [[ "$svc_status" != "ACTIVE" || -z "$current_td" || "$current_td" == "None" || "$current_td" == "null" ]]; then
    if is_optional_service "$service" "$OPTIONAL_SERVICES"; then
      log "service=$service: status=$svc_status; skipping (optional)"
      return 0
    fi
    echo "[deploy] service=$service not ACTIVE or missing task definition (status=$svc_status taskDef=$current_td)" >&2
    exit 1
  fi

  log "service=$service: registering new task definition with image=$image_uri"
  local new_td_json
  local container_name="$service"
  if [[ "$container_name" == "${PREFIX}-"* ]]; then
    container_name="${container_name#${PREFIX}-}"
  fi
  new_td_json="$(render_new_taskdef "$current_td" "$image_uri" "$container_name")"

  # The scanner service runs with a clamd sidecar container. The deploy pipeline updates the app
  # image frequently, but the clamd image should remain stable (and must be TCP-enabled).
  #
  # Some upstream clamav images default to Unix sockets only; our scanner connects over TCP.
  # Use a known-good image by default, and allow override via CLAMAV_IMAGE.
  if [[ "$service" == "${PREFIX}-scanner" ]]; then
    new_td_json="$(jq --arg IMG "$CLAMAV_IMAGE" '(.containerDefinitions[] | select(.name=="clamd") | .image) = $IMG' <<<"$new_td_json")"

    # Ensure scanner can talk to clamd in ECS/Fargate.
    #
    # In awsvpc mode, 127.0.0.1 is container-local. Rather than rely on TCP, share clamd's unix
    # socket via an ephemeral task volume mounted at /tmp in both containers.
    new_td_json="$(jq '
      .volumes = (.volumes // [])
      | if ([.volumes[]? | select(.name=="clamd-tmp")] | length) == 0 then .volumes += [{name:"clamd-tmp"}] else . end
      | (.containerDefinitions[] | select(.name=="scanner") | .mountPoints) =
          ((.containerDefinitions[] | select(.name=="scanner") | .mountPoints // []) as $m
            | if ([ $m[]? | select(.sourceVolume=="clamd-tmp" and .containerPath=="/tmp") ] | length) == 0
              then $m + [{sourceVolume:"clamd-tmp",containerPath:"/tmp",readOnly:false}]
              else $m
            end)
      | (.containerDefinitions[] | select(.name=="clamd") | .mountPoints) =
          ((.containerDefinitions[] | select(.name=="clamd") | .mountPoints // []) as $m
            | if ([ $m[]? | select(.sourceVolume=="clamd-tmp" and .containerPath=="/tmp") ] | length) == 0
              then $m + [{sourceVolume:"clamd-tmp",containerPath:"/tmp",readOnly:false}]
              else $m
            end)
      | (.containerDefinitions[] | select(.name=="clamd") | .entryPoint) = ["sh","-lc"]
      | (.containerDefinitions[] | select(.name=="clamd") | .command) = ["chmod 1777 /tmp && exec /init"]
      | (.containerDefinitions[] | select(.name=="scanner") | .environment) =
          ((.containerDefinitions[] | select(.name=="scanner") | .environment // [])
            | map(select(.name!="CLAMD_SOCKET")) + [{name:"CLAMD_SOCKET",value:"/tmp/clamd.sock"}])
    ' <<<"$new_td_json")"
  fi
  local new_td_arn
  new_td_arn="$(aws ecs register-task-definition --cli-input-json "$new_td_json" --query 'taskDefinition.taskDefinitionArn' --output text)"
  if [[ -z "$new_td_arn" || "$new_td_arn" == "None" ]]; then
    echo "[deploy] register-task-definition returned empty arn for service=$service" >&2
    exit 1
  fi

  log "service=$service: updating ECS service to taskDefinition=$new_td_arn"
  aws ecs update-service --cluster "$CLUSTER" --service "$service" --task-definition "$new_td_arn" >/dev/null

  WAIT_SERVICES+=("$service")
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
  # NOTE: awscli prints an extra "None" line for paginated text output; grab the first line only.
  migrate_td="$(aws ecs list-task-definitions --family-prefix "$MIGRATE_TASK_FAMILY" --sort DESC --max-items 1 --query 'taskDefinitionArns[0]' --output text | head -n 1)"
  if [[ -z "$migrate_td" || "$migrate_td" == "None" ]]; then
    echo "[deploy] migrate task definition not found for family=${MIGRATE_TASK_FAMILY}" >&2
    exit 1
  fi

  # Ensure migrations run from the *new* app image (so new SQL files are present in the container).
  log "registering migrate task definition revision with new app image..."
  local migrate_td_json
  migrate_td_json="$(render_new_taskdef "$migrate_td" "$APP_IMAGE_URI" "migrate")"
  # Terraform's migrate task uses a stable command path. Our TS build outputs under dist/src/.
  # Patch the command here to keep deploys working even if an older task def still points to dist/db/.
  migrate_td_json="$(jq '(.containerDefinitions[] | select(.name=="migrate") | .command) = ["node","dist/src/db/migrate.js"]' <<<"$migrate_td_json")"
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
  if [[ "${#WAIT_SERVICES[@]}" -eq 0 ]]; then
    echo "[deploy] no ACTIVE services were updated; refusing to call services-stable" >&2
    exit 1
  fi
  aws ecs wait services-stable --cluster "$CLUSTER" --services "${WAIT_SERVICES[@]}"

  log "deploy OK"
}

main "$@"
