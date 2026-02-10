resource "aws_ecs_cluster" "main" {
  name = "${local.name}-cluster"
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.name}/api"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "verifier_gateway" {
  name              = "/ecs/${local.name}/verifier-gateway"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "outbox" {
  name              = "/ecs/${local.name}/outbox"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "verification" {
  name              = "/ecs/${local.name}/verification"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "payout" {
  name              = "/ecs/${local.name}/payout"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "scanner" {
  name              = "/ecs/${local.name}/scanner"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "retention" {
  name              = "/ecs/${local.name}/retention"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "alarm_inbox" {
  name              = "/ecs/${local.name}/alarm-inbox"
  retention_in_days = 14
}

resource "aws_service_discovery_private_dns_namespace" "internal" {
  name        = "${local.name}.local"
  description = "Internal service discovery"
  vpc         = local.vpc_id
}

resource "aws_service_discovery_service" "api" {
  name = "api"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.internal.id
    dns_records {
      ttl  = 10
      type = "A"
    }
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

resource "aws_service_discovery_service" "verifier_gateway" {
  name = "verifier-gateway"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.internal.id
    dns_records {
      ttl  = 10
      type = "A"
    }
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

locals {
  api_internal_base = "http://api.${aws_service_discovery_private_dns_namespace.internal.name}:3000"
  verifier_url      = "http://verifier-gateway.${aws_service_discovery_private_dns_namespace.internal.name}:4010/run"
  # PUBLIC_BASE_URL is used by the API to generate absolute artifact URLs.
  # Prefer explicit var.public_base_url. Otherwise:
  # - when enable_alb=true and enable_cloudfront=true: use the CloudFront default domain (HTTPS)
  # - when enable_alb=true: use the ALB DNS name (HTTPS only if ACM is configured)
  # - when enable_router_instance=true: use the router EC2 public DNS
  public_base_url = var.public_base_url != "" ? var.public_base_url : (
    var.enable_alb ? (
      local.cloudfront_alb_enabled ? "https://${aws_cloudfront_distribution.alb[0].domain_name}" : (
        var.acm_certificate_arn != "" ? "https://${aws_lb.api[0].dns_name}" : "http://${aws_lb.api[0].dns_name}"
      )
      ) : (
      local.cloudfront_router_enabled ? "https://${aws_cloudfront_distribution.router[0].domain_name}" : (
        var.enable_router_instance ? (
          var.router_use_eip ? "http://${aws_eip.router[0].public_ip}" : "http://${aws_instance.router[0].public_ip}"
        ) : ""
      )
    )
  )

  common_env = [
    { name = "NODE_ENV", value = "production" },
    # Router mode is HTTP-only (no ALB/CloudFront in some AWS accounts). Disable HTTPS enforcement
    # at the app layer unless an ACM-backed ALB is configured.
    { name = "ENFORCE_HTTPS", value = var.enable_alb && var.acm_certificate_arn != "" ? "true" : "false" },
    { name = "DEBUG_RESPONSE_HEADERS", value = var.debug_response_headers ? "true" : "false" },
    { name = "DB_SSL", value = "true" },
    { name = "PUBLIC_BASE_URL", value = local.public_base_url },
    { name = "STORAGE_BACKEND", value = "s3" },
    { name = "S3_REGION", value = var.aws_region },
    { name = "S3_BUCKET_STAGING", value = aws_s3_bucket.staging.bucket },
    { name = "S3_BUCKET_CLEAN", value = aws_s3_bucket.clean.bucket },
    { name = "S3_BUCKET_QUARANTINE", value = aws_s3_bucket.quarantine.bucket },
    { name = "CORS_ALLOW_ORIGINS", value = var.cors_allow_origins },
  ]

  base_secrets = [
    { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
    { name = "WORKER_TOKEN_PEPPER", valueFrom = aws_secretsmanager_secret.worker_token_pepper.arn },
    { name = "BUYER_TOKEN_PEPPER", valueFrom = aws_secretsmanager_secret.buyer_token_pepper.arn },
    { name = "VERIFIER_TOKEN_HASH", valueFrom = aws_secretsmanager_secret.verifier_token_hash.arn },
    { name = "VERIFIER_TOKEN", valueFrom = aws_secretsmanager_secret.verifier_token.arn },
    { name = "ADMIN_TOKEN_HASH", valueFrom = aws_secretsmanager_secret.admin_token_hash.arn },
    { name = "SESSION_SECRET", valueFrom = aws_secretsmanager_secret.session_secret.arn },
  ]

  verifier_gateway_image = var.verifier_gateway_image_uri != "" ? var.verifier_gateway_image_uri : var.image_uri

  verifier_gateway_secrets = [
    { name = "VERIFIER_TOKEN", valueFrom = aws_secretsmanager_secret.verifier_token.arn }
  ]

  stripe_secrets = concat(
    var.stripe_secret_key != "" ? [{ name = "STRIPE_SECRET_KEY", valueFrom = aws_secretsmanager_secret.stripe_secret_key.arn }] : [],
    var.stripe_webhook_secret != "" ? [{ name = "STRIPE_WEBHOOK_SECRET", valueFrom = aws_secretsmanager_secret.stripe_webhook_secret.arn }] : []
  )
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = var.image_uri
      essential = true
      portMappings = [
        { containerPort = 3000, hostPort = 3000, protocol = "tcp" }
      ]
      environment = concat(local.common_env, [
        { name = "PORT", value = "3000" },
        { name = "MAX_VERIFICATION_ATTEMPTS", value = "3" }
      ])
      secrets = concat(local.base_secrets, local.stripe_secrets)
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.api.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "api"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "api" {
  name            = "${local.name}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.desired_count_api
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = var.ecs_assign_public_ip
  }

  dynamic "load_balancer" {
    for_each = var.enable_alb ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.api.arn
      container_name   = "api"
      container_port   = 3000
    }
  }

  service_registries {
    registry_arn   = aws_service_discovery_service.api.arn
    container_name = "api"
  }

  # Keep a static depends_on so Terraform can order ALB listener creation ahead of the ECS service
  # when enable_alb=true. When enable_alb=false, the listener resources have count=0 and this is a no-op.
  depends_on = [aws_lb_listener.http, aws_lb_listener.https]
}

resource "aws_ecs_task_definition" "verifier_gateway" {
  family                   = "${local.name}-verifier-gateway"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "verifier-gateway"
      image     = local.verifier_gateway_image
      essential = true
      command   = ["node", "dist/services/verifier-gateway/server.js"]
      portMappings = [
        { containerPort = 4010, hostPort = 4010, protocol = "tcp" }
      ]
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "API_BASE_URL", value = local.api_internal_base },
        { name = "VERIFIER_GATEWAY_PORT", value = "4010" },
        { name = "VERIFIER_GATEWAY_HOST", value = "0.0.0.0" }
      ]
      secrets = local.verifier_gateway_secrets
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.verifier_gateway.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "verifier-gateway"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "verifier_gateway" {
  name            = "${local.name}-verifier-gateway"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.verifier_gateway.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = var.ecs_assign_public_ip
  }

  service_registries {
    registry_arn   = aws_service_discovery_service.verifier_gateway.arn
    container_name = "verifier-gateway"
  }
}

locals {
  worker_defs = merge(
    {
      outbox = {
        command         = ["node", "dist/workers/outbox-dispatcher.js"]
        log_group       = aws_cloudwatch_log_group.outbox.name
        extra_env       = [{ name = "OUTBOX_HEALTH_PORT", value = "9101" }]
        extra_secrets   = []
        health_port_env = "OUTBOX_HEALTH_PORT"
      }
      verification = {
        command         = ["node", "dist/workers/verification-runner.js"]
        log_group       = aws_cloudwatch_log_group.verification.name
        extra_env       = [{ name = "VERIFICATION_HEALTH_PORT", value = "9102" }, { name = "VERIFIER_GATEWAY_URL", value = local.verifier_url }]
        extra_secrets   = []
        health_port_env = "VERIFICATION_HEALTH_PORT"
      }
      payout = {
        command   = ["node", "dist/workers/payout-runner.js"]
        log_group = aws_cloudwatch_log_group.payout.name
        extra_env = [
          { name = "PAYOUT_HEALTH_PORT", value = "9103" },
          { name = "PAYMENTS_PROVIDER", value = var.payments_provider },
          { name = "API_BASE_URL", value = local.api_internal_base },
          { name = "KMS_PAYOUT_KEY_ID", value = aws_kms_key.payout_signer.key_id },
          { name = "BASE_RPC_URL", value = var.base_rpc_url },
          { name = "BASE_PAYOUT_SPLITTER_ADDRESS", value = var.base_payout_splitter_address },
          { name = "BASE_CONFIRMATIONS_REQUIRED", value = tostring(var.base_confirmations_required) },
          { name = "PROOFWORK_FEE_BPS", value = tostring(var.platform_fee_bps) },
          { name = "PROOFWORK_FEE_WALLET_BASE", value = var.platform_fee_wallet_base },
          # Backwards-compat for older code/scripts that still use PLATFORM_* envs.
          { name = "PLATFORM_FEE_BPS", value = tostring(var.platform_fee_bps) },
          { name = "PLATFORM_FEE_WALLET_BASE", value = var.platform_fee_wallet_base }
        ]
        extra_secrets   = []
        health_port_env = "PAYOUT_HEALTH_PORT"
      }
      scanner = {
        command   = ["node", "dist/workers/scanner-runner.js"]
        log_group = aws_cloudwatch_log_group.scanner.name
        extra_env = [
          { name = "SCANNER_HEALTH_PORT", value = "9104" },
          { name = "SCANNER_ENGINE", value = "clamd" },
          # In ECS/Fargate awsvpc mode, containers do not share 127.0.0.1; prefer the unix socket.
          { name = "CLAMD_SOCKET", value = "/tmp/clamd.sock" },
          { name = "CLAMD_HOST", value = "127.0.0.1" },
          { name = "CLAMD_PORT", value = "3310" }
        ]
        extra_secrets   = []
        health_port_env = "SCANNER_HEALTH_PORT"
        cpu             = 512
        memory          = 1024
      }
      retention = {
        command         = ["node", "dist/workers/retention-runner.js"]
        log_group       = aws_cloudwatch_log_group.retention.name
        extra_env       = [{ name = "RETENTION_HEALTH_PORT", value = "9105" }]
        extra_secrets   = []
        health_port_env = "RETENTION_HEALTH_PORT"
      }
    },
    local.alarm_inbox_enabled ? {
      alarm_inbox = {
        command   = ["node", "dist/workers/alarm-inbox-runner.js"]
        log_group = aws_cloudwatch_log_group.alarm_inbox.name
        extra_env = [
          { name = "ALARM_INBOX_HEALTH_PORT", value = "9106" },
          { name = "ALARM_INBOX_QUEUE_URL", value = aws_sqs_queue.alarm_inbox[0].url },
          { name = "ENVIRONMENT", value = var.environment }
        ]
        extra_secrets   = []
        health_port_env = "ALARM_INBOX_HEALTH_PORT"
      }
    } : {}
  )
}

resource "aws_ecs_task_definition" "workers" {
  for_each                 = local.worker_defs
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(try(each.value.cpu, 256))
  memory                   = tostring(try(each.value.memory, 512))
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  dynamic "volume" {
    for_each = each.key == "scanner" ? [1] : []
    content {
      name = "clamd-tmp"
    }
  }

  container_definitions = jsonencode(
    concat(
      [
        {
          name      = each.key
          image     = var.image_uri
          essential = true
          command   = each.value.command
          environment = concat(local.common_env, [
            { name = "API_BASE_URL", value = local.api_internal_base }
          ], each.value.extra_env)
          secrets = local.base_secrets
          mountPoints = each.key == "scanner" ? [
            { sourceVolume = "clamd-tmp", containerPath = "/tmp", readOnly = false }
          ] : []
          healthCheck = {
            command     = ["CMD-SHELL", format("wget -q -O - http://127.0.0.1:$%s/health >/dev/null 2>&1 || exit 1", each.value.health_port_env)]
            interval    = 30
            timeout     = 5
            retries     = 3
            startPeriod = 30
          }
          logConfiguration = {
            logDriver = "awslogs"
            options = {
              awslogs-group         = each.value.log_group
              awslogs-region        = var.aws_region
              awslogs-stream-prefix = each.key
            }
          }
        }
      ],
      each.key == "scanner" ? [
        {
          name      = "clamd"
          image     = var.clamav_image
          essential = true
          entryPoint = ["sh", "-lc"]
          command    = ["chmod 1777 /tmp && exec /init"]
          mountPoints = [
            { sourceVolume = "clamd-tmp", containerPath = "/tmp", readOnly = false }
          ]
          portMappings = [
            { containerPort = 3310, hostPort = 3310, protocol = "tcp" }
          ]
          logConfiguration = {
            logDriver = "awslogs"
            options = {
              awslogs-group         = aws_cloudwatch_log_group.scanner.name
              awslogs-region        = var.aws_region
              awslogs-stream-prefix = "clamd"
            }
          }
        }
      ] : []
    )
  )
}

resource "aws_ecs_service" "workers" {
  for_each        = local.worker_defs
  name            = "${local.name}-${each.key}"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.workers[each.key].arn
  desired_count   = var.desired_count_workers
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = var.ecs_assign_public_ip
  }
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "migrate"
      image     = var.image_uri
      essential = true
      command   = ["node", "dist/db/migrate.js"]
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "DB_SSL", value = "true" }
      ]
      secrets = local.base_secrets
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.api.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "migrate"
        }
      }
    }
  ])
}
