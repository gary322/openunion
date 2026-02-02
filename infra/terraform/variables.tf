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
  description = "Public base URL for API (used in artifact finalUrl), e.g. https://api.example.com. If empty, defaults to the created ALB DNS name (http://...)."
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

variable "session_secret" {
  type      = string
  sensitive = true
}

variable "cors_allow_origins" {
  type        = string
  default     = ""
  description = "Comma-separated list of allowed CORS origins for the API."
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
