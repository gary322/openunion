data "aws_vpc" "default" {
  count   = var.vpc_id == "" ? 1 : 0
  default = true
}

locals {
  vpc_id = var.vpc_id != "" ? var.vpc_id : data.aws_vpc.default[0].id
  name   = "${var.project_name}-${var.environment}"
}

data "aws_subnets" "default" {
  count = length(var.public_subnet_ids) == 0 ? 1 : 0
  filter {
    name   = "vpc-id"
    values = [local.vpc_id]
  }
}

locals {
  public_subnet_ids  = length(var.public_subnet_ids) > 0 ? var.public_subnet_ids : slice(data.aws_subnets.default[0].ids, 0, 2)
  private_subnet_ids = length(var.private_subnet_ids) > 0 ? var.private_subnet_ids : local.public_subnet_ids
}

