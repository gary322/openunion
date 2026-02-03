resource "aws_s3_bucket" "staging" {
  # S3 bucket names are global; include account_id to avoid cross-account collisions.
  bucket = "${local.name}-${data.aws_caller_identity.current.account_id}-artifacts-staging"
}

resource "aws_s3_bucket" "clean" {
  bucket = "${local.name}-${data.aws_caller_identity.current.account_id}-artifacts-clean"
}

resource "aws_s3_bucket" "quarantine" {
  bucket = "${local.name}-${data.aws_caller_identity.current.account_id}-artifacts-quarantine"
}

resource "aws_s3_bucket_public_access_block" "staging" {
  bucket                  = aws_s3_bucket.staging.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "clean" {
  bucket                  = aws_s3_bucket.clean.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "quarantine" {
  bucket                  = aws_s3_bucket.quarantine.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
