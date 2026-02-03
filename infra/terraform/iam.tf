data "aws_iam_policy_document" "ecs_task_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-ecs-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret"
    ]
    resources = [
      aws_secretsmanager_secret.database_url.arn,
      aws_secretsmanager_secret.stripe_secret_key.arn,
      aws_secretsmanager_secret.stripe_webhook_secret.arn,
      aws_secretsmanager_secret.worker_token_pepper.arn,
      aws_secretsmanager_secret.buyer_token_pepper.arn,
      aws_secretsmanager_secret.verifier_token_hash.arn,
      aws_secretsmanager_secret.verifier_token.arn,
      aws_secretsmanager_secret.admin_token_hash.arn,
      aws_secretsmanager_secret.session_secret.arn
    ]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "${local.name}-ecs-exec-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

data "aws_iam_policy_document" "task_policy" {
  statement {
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret"
    ]
    resources = [
      aws_secretsmanager_secret.database_url.arn,
      aws_secretsmanager_secret.stripe_secret_key.arn,
      aws_secretsmanager_secret.stripe_webhook_secret.arn,
      aws_secretsmanager_secret.worker_token_pepper.arn,
      aws_secretsmanager_secret.buyer_token_pepper.arn,
      aws_secretsmanager_secret.verifier_token_hash.arn,
      aws_secretsmanager_secret.verifier_token.arn,
      aws_secretsmanager_secret.admin_token_hash.arn,
      aws_secretsmanager_secret.session_secret.arn
    ]
  }

  statement {
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.staging.arn, "${aws_s3_bucket.staging.arn}/*",
      aws_s3_bucket.clean.arn, "${aws_s3_bucket.clean.arn}/*",
      aws_s3_bucket.quarantine.arn, "${aws_s3_bucket.quarantine.arn}/*"
    ]
  }

  statement {
    actions = [
      "kms:GetPublicKey",
      "kms:Sign"
    ]
    resources = [aws_kms_key.payout_signer.arn]
  }

  dynamic "statement" {
    for_each = local.alarm_inbox_enabled ? [1] : []
    content {
      actions = [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:ChangeMessageVisibility"
      ]
      resources = [aws_sqs_queue.alarm_inbox[0].arn]
    }
  }
}

resource "aws_iam_role_policy" "task_inline" {
  name   = "${local.name}-ecs-task-inline"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_policy.json
}
