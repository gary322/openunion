# Terraform (AWS ECS + RDS + S3 + KMS + Secrets)

This is a minimal, production-oriented Terraform setup for running Proofwork on **AWS ECS/Fargate** behind an **ALB**, with **RDS Postgres**, **private S3 buckets** (staging/clean/quarantine), **KMS secp256k1** for payouts, and **Secrets Manager** for configuration.

## Prereqs
- Terraform `>= 1.6`
- An ECR image built from this repo’s `Dockerfile` (set `image_uri`)
- (Recommended) A non-default VPC with **public + private subnets**
  - For `environment=prod` this module **requires** explicit `vpc_id`, `public_subnet_ids`, and `private_subnet_ids`

## Apply
```bash
cd infra/terraform
terraform init

terraform apply \
  -var 'image_uri=YOUR_ECR_IMAGE_URI' \
  -var 'verifier_gateway_image_uri=YOUR_VERIFIER_GATEWAY_IMAGE_URI' \
  -var 'public_base_url=https://YOUR_DOMAIN_OR_ALB' \
  -var 'worker_token_pepper=...' \
  -var 'buyer_token_pepper=...' \
  -var 'verifier_token_hash=...' \
  -var 'verifier_token=...' \
  -var 'admin_token_hash=...' \
  -var 'admin_token=...' \
  -var 'session_secret=...'
```

## Migrations on deploy (recommended)
Run the migration task **once** per deploy before rolling services:
- Task definition ARN output: `migrate_task_definition_arn`
- Command executed: `node dist/db/migrate.js`

## Notes
- Payouts (crypto) require setting:
  - `base_rpc_url`
  - `base_payout_splitter_address`
  - `platform_fee_wallet_base` (Proofwork fee recipient)
- Stripe topups require setting:
  - `stripe_secret_key`
  - `stripe_webhook_secret`
- Verifier gateway (Playwright):
  - build/push `services/verifier-gateway/Dockerfile` and set `verifier_gateway_image_uri`
- Malware scanning:
  - Scanner workers run `SCANNER_ENGINE=clamd` and include a `clamd` sidecar (image configurable via `clamav_image`)
