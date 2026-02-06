output "public_url" {
  value       = local.public_base_url
  description = "Public base URL for the API (CloudFront (if enabled), ALB DNS, router instance, or explicit public_base_url)."
}

output "alb_dns_name" {
  value       = var.enable_alb ? aws_lb.api[0].dns_name : null
  description = "ALB DNS name when enable_alb=true."
}

output "cloudfront_domain" {
  value = local.cloudfront_enabled ? (
    local.cloudfront_alb_enabled ? aws_cloudfront_distribution.alb[0].domain_name : aws_cloudfront_distribution.router[0].domain_name
  ) : null
  description = "CloudFront distribution domain when enable_cloudfront=true (ALB or router mode)."
}

output "router_public_ip" {
  value       = var.enable_router_instance ? (var.router_use_eip ? aws_eip.router[0].public_ip : aws_instance.router[0].public_ip) : null
  description = "Router public IP when enable_router_instance=true (EIP if router_use_eip=true, otherwise the instance public IP)."
}

output "router_public_dns" {
  value       = var.enable_router_instance ? aws_instance.router[0].public_dns : null
  description = "Router EC2 public DNS (may change on replacement); prefer router_public_ip or public_url."
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

output "alarm_sns_topic_arn" {
  value       = local.effective_alarm_topic_arn != "" ? local.effective_alarm_topic_arn : null
  description = "SNS topic ARN used for CloudWatch alarm notifications (BYO alarm_sns_topic_arn or created when create_alarm_sns_topic=true)."
}

output "alarm_inbox_queue_url" {
  value       = local.alarm_inbox_enabled ? aws_sqs_queue.alarm_inbox[0].url : null
  description = "SQS queue URL for the internal alarm inbox (SNS->SQS)."
}

output "alarm_inbox_queue_arn" {
  value       = local.alarm_inbox_enabled ? aws_sqs_queue.alarm_inbox[0].arn : null
  description = "SQS queue ARN for the internal alarm inbox (SNS->SQS)."
}
