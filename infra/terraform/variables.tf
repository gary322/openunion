variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "project_name" {
  type    = string
  default = "proofwork"
}

variable "environment" {
  type    = string
  default = "staging"

  validation {
    condition     = length(var.environment) > 0
    error_message = "environment must be set (e.g. staging|prod)."
  }
}

variable "image_uri" {
  type        = string
  description = "Container image URI (e.g. ECR image) containing the built app/worker code."
}

variable "public_base_url" {
  type        = string
  default     = ""
  description = "Public base URL for API (used in artifact finalUrl), e.g. https://api.example.com. If empty, defaults to the created ALB DNS name (http://...) when enable_alb=true, or the router instance DNS when enable_router_instance=true."
}

variable "enable_alb" {
  type        = bool
  default     = true
  description = "Whether to create an AWS ALB in front of the API service. Some AWS accounts may be restricted from creating ELB/ALB."
}

variable "enable_router_instance" {
  type        = bool
  default     = false
  description = "Fallback when enable_alb=false: create a small EC2 reverse-proxy (nginx) that forwards to the internal ECS service discovery name, avoiding ALB."
}

variable "enable_cloudfront" {
  type        = bool
  default     = false
  description = "Optionally create a CloudFront distribution to provide HTTPS without a custom domain (default *.cloudfront.net). Works in both ALB mode (CloudFront -> ALB) and router mode (CloudFront -> router instance)."
}

variable "cloudfront_price_class" {
  type        = string
  default     = "PriceClass_100"
  description = "CloudFront price class when enable_cloudfront=true."
}

variable "router_instance_type" {
  type        = string
  default     = "t3.micro"
  description = "Instance type for the optional router reverse-proxy."
}

variable "router_use_eip" {
  type        = bool
  default     = true
  description = "When enable_router_instance=true, whether to allocate and attach an Elastic IP. If your account has EIP quota limits, set this to false and use the instance public IP."
}

variable "vpc_id" {
  type        = string
  default     = ""
  description = "Optional VPC id. If empty, uses the default VPC."
}

variable "public_subnet_ids" {
  type        = list(string)
  default     = []
  description = "Optional list of public subnet ids for ALB/ECS. If empty, uses default VPC subnets."
}

variable "private_subnet_ids" {
  type        = list(string)
  default     = []
  description = "Optional list of private subnet ids for RDS/ECS. If empty, falls back to public subnets."
}

variable "acm_certificate_arn" {
  type        = string
  default     = ""
  description = "Optional ACM certificate ARN for HTTPS on the ALB. If empty, only HTTP (port 80) is created."
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 20
}

variable "db_username" {
  type    = string
  default = "postgres"
}

variable "db_name" {
  type    = string
  default = "proofwork"
}

variable "db_publicly_accessible" {
  type    = bool
  default = false
}

variable "db_multi_az" {
  type    = bool
  default = false
}

variable "db_backup_retention_days" {
  type    = number
  default = 7
}

variable "db_deletion_protection" {
  type    = bool
  default = false
}

variable "db_skip_final_snapshot" {
  type    = bool
  default = true
}

variable "ecs_assign_public_ip" {
  type    = bool
  default = true
}

variable "desired_count_api" {
  type    = number
  default = 1
}

variable "desired_count_workers" {
  type    = number
  default = 1
}

variable "payments_provider" {
  type        = string
  default     = "mock"
  description = "Payment provider for payout worker: mock|http|crypto_base_usdc|crypto_evm_local. Use mock for staging if you don't have on-chain payout config yet."
}

variable "verifier_gateway_image_uri" {
  type        = string
  default     = ""
  description = "Optional separate image URI for the verifier gateway (Playwright-based). If empty, defaults to image_uri."
}

variable "clamav_image" {
  type        = string
  default     = "clamav/clamav:stable"
  description = "Container image for clamd sidecar."
}

variable "enable_autoscaling" {
  type    = bool
  default = true
}

variable "api_min_capacity" {
  type    = number
  default = 1
}

variable "api_max_capacity" {
  type    = number
  default = 3
}

variable "api_cpu_target" {
  type    = number
  default = 50
}

variable "workers_min_capacity" {
  type    = number
  default = 1
}

variable "workers_max_capacity" {
  type    = number
  default = 2
}

variable "workers_cpu_target" {
  type    = number
  default = 60
}

variable "enable_waf" {
  type    = bool
  default = false
}

variable "waf_rate_limit" {
  type    = number
  default = 2000
}

variable "alarm_sns_topic_arn" {
  type        = string
  default     = ""
  description = "Optional SNS topic ARN to notify on CloudWatch alarms."
}

variable "create_alarm_sns_topic" {
  type        = bool
  default     = false
  description = "If true (and alarm_sns_topic_arn is empty), create an SNS topic for CloudWatch alarm notifications."
}

variable "alarm_sns_topic_name" {
  type        = string
  default     = ""
  description = "Optional SNS topic name for alarm notifications (defaults to <project>-<env>-alarms)."
}

variable "alarm_email_subscriptions" {
  type        = list(string)
  default     = []
  description = "List of email addresses to subscribe to the created alarm SNS topic (requires email confirmation)."
}

variable "alarm_https_subscriptions" {
  type        = list(string)
  default     = []
  description = "List of HTTPS endpoints to subscribe to the created alarm SNS topic (PagerDuty/Opsgenie/webhook)."
}

variable "enable_alarm_inbox" {
  type        = bool
  default     = true
  description = "If true, create an internal SNS->SQS alarm inbox and run an ECS worker that stores notifications in Postgres for the admin UI."
}

variable "alarm_inbox_retention_seconds" {
  type        = number
  default     = 1209600 # 14 days
  description = "SQS retention for the alarm inbox queue."
}

variable "stripe_secret_key" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Stripe secret key used to create checkout sessions."
}

variable "stripe_webhook_secret" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Stripe webhook signing secret (whsec_...)"
}

variable "worker_token_pepper" {
  type      = string
  sensitive = true
}

variable "buyer_token_pepper" {
  type      = string
  sensitive = true
}

variable "verifier_token_hash" {
  type      = string
  sensitive = true
}

variable "verifier_token" {
  type        = string
  sensitive   = true
  description = "Verifier bearer token preimage used by internal verifier workers/gateway to call the API."
}

variable "admin_token_hash" {
  type      = string
  sensitive = true
}

variable "admin_token" {
  type        = string
  sensitive   = true
  description = "Admin bearer token preimage used by humans/tools to access /api/admin/*."
}

variable "session_secret" {
  type      = string
  sensitive = true
}

variable "cors_allow_origins" {
  type        = string
  default     = ""
  description = "Comma-separated list of allowed CORS origins for the API."
}

variable "debug_response_headers" {
  type        = bool
  default     = false
  description = "If true, the API will include x-debug-* headers (staging only; do not enable in production)."
}

variable "platform_fee_bps" {
  type = number
  # Proofwork's fixed fee in basis points (default 1%).
  default = 100
}

variable "platform_fee_wallet_base" {
  type        = string
  default     = ""
  description = "Base chain address that receives the Proofwork fee."
}

variable "base_rpc_url" {
  type        = string
  default     = ""
  description = "Base RPC URL used by the payout worker (required when PAYMENTS_PROVIDER=crypto_base_usdc)."
}

variable "base_payout_splitter_address" {
  type        = string
  default     = ""
  description = "Deployed PayoutSplitter contract address on Base."
}

variable "base_confirmations_required" {
  type    = number
  default = 5
}
