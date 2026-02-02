resource "aws_secretsmanager_secret" "database_url" {
  name = "${local.name}/DATABASE_URL"
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = "postgresql://${var.db_username}:${random_password.db.result}@${aws_db_instance.postgres.address}:5432/${var.db_name}"
}

resource "aws_secretsmanager_secret" "stripe_secret_key" {
  name = "${local.name}/STRIPE_SECRET_KEY"
}

resource "aws_secretsmanager_secret_version" "stripe_secret_key" {
  count         = var.stripe_secret_key != "" ? 1 : 0
  secret_id     = aws_secretsmanager_secret.stripe_secret_key.id
  secret_string = var.stripe_secret_key
}

resource "aws_secretsmanager_secret" "stripe_webhook_secret" {
  name = "${local.name}/STRIPE_WEBHOOK_SECRET"
}

resource "aws_secretsmanager_secret_version" "stripe_webhook_secret" {
  count         = var.stripe_webhook_secret != "" ? 1 : 0
  secret_id     = aws_secretsmanager_secret.stripe_webhook_secret.id
  secret_string = var.stripe_webhook_secret
}

resource "aws_secretsmanager_secret" "worker_token_pepper" {
  name = "${local.name}/WORKER_TOKEN_PEPPER"
}
resource "aws_secretsmanager_secret_version" "worker_token_pepper" {
  secret_id     = aws_secretsmanager_secret.worker_token_pepper.id
  secret_string = var.worker_token_pepper
}

resource "aws_secretsmanager_secret" "buyer_token_pepper" {
  name = "${local.name}/BUYER_TOKEN_PEPPER"
}
resource "aws_secretsmanager_secret_version" "buyer_token_pepper" {
  secret_id     = aws_secretsmanager_secret.buyer_token_pepper.id
  secret_string = var.buyer_token_pepper
}

resource "aws_secretsmanager_secret" "verifier_token_hash" {
  name = "${local.name}/VERIFIER_TOKEN_HASH"
}
resource "aws_secretsmanager_secret_version" "verifier_token_hash" {
  secret_id     = aws_secretsmanager_secret.verifier_token_hash.id
  secret_string = var.verifier_token_hash
}

resource "aws_secretsmanager_secret" "verifier_token" {
  name = "${local.name}/VERIFIER_TOKEN"
}
resource "aws_secretsmanager_secret_version" "verifier_token" {
  secret_id     = aws_secretsmanager_secret.verifier_token.id
  secret_string = var.verifier_token
}

resource "aws_secretsmanager_secret" "admin_token_hash" {
  name = "${local.name}/ADMIN_TOKEN_HASH"
}
resource "aws_secretsmanager_secret_version" "admin_token_hash" {
  secret_id     = aws_secretsmanager_secret.admin_token_hash.id
  secret_string = var.admin_token_hash
}

resource "aws_secretsmanager_secret" "session_secret" {
  name = "${local.name}/SESSION_SECRET"
}
resource "aws_secretsmanager_secret_version" "session_secret" {
  secret_id     = aws_secretsmanager_secret.session_secret.id
  secret_string = var.session_secret
}

