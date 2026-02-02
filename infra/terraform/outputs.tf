output "alb_dns_name" {
  value = aws_lb.api.dns_name
}

output "rds_endpoint" {
  value = aws_db_instance.postgres.address
}

output "kms_payout_key_id" {
  value = aws_kms_key.payout_signer.key_id
}

output "s3_buckets" {
  value = {
    staging    = aws_s3_bucket.staging.bucket
    clean      = aws_s3_bucket.clean.bucket
    quarantine = aws_s3_bucket.quarantine.bucket
  }
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "migrate_task_definition_arn" {
  value = aws_ecs_task_definition.migrate.arn
}

