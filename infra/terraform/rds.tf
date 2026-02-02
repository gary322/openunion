resource "random_password" "db" {
  length  = 24
  special = true
}

resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db-subnets"
  subnet_ids = local.private_subnet_ids
}

resource "aws_security_group" "db" {
  name        = "${local.name}-db-sg"
  description = "RDS access from ECS tasks"
  vpc_id      = local.vpc_id
}

resource "aws_security_group_rule" "db_ingress" {
  type                     = "ingress"
  security_group_id        = aws_security_group.db.id
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.ecs_tasks.id
}

resource "aws_security_group_rule" "db_egress" {
  type              = "egress"
  security_group_id = aws_security_group.db.id
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
}

resource "aws_db_instance" "postgres" {
  identifier             = "${local.name}-db"
  engine                 = "postgres"
  engine_version         = "16"
  instance_class         = var.db_instance_class
  allocated_storage      = var.db_allocated_storage_gb
  db_name                = var.db_name
  username               = var.db_username
  password               = random_password.db.result
  publicly_accessible    = var.db_publicly_accessible
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]

  multi_az                   = var.db_multi_az
  backup_retention_period    = var.db_backup_retention_days
  deletion_protection        = var.db_deletion_protection
  auto_minor_version_upgrade = true

  skip_final_snapshot       = var.db_skip_final_snapshot
  final_snapshot_identifier = var.db_skip_final_snapshot ? null : "${local.name}-final"
}

