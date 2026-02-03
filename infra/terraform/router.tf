data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_security_group" "router" {
  count       = var.enable_router_instance ? 1 : 0
  name        = "${local.name}-router-sg"
  description = "Public reverse proxy (nginx) to internal ECS service discovery"
  vpc_id      = local.vpc_id
}

resource "aws_security_group_rule" "router_ingress_http" {
  count             = var.enable_router_instance ? 1 : 0
  type              = "ingress"
  security_group_id = aws_security_group.router[0].id
  from_port         = 80
  to_port           = 80
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
}

resource "aws_security_group_rule" "router_egress" {
  count             = var.enable_router_instance ? 1 : 0
  type              = "egress"
  security_group_id = aws_security_group.router[0].id
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
}

resource "aws_security_group_rule" "ecs_ingress_from_router" {
  count                    = var.enable_router_instance ? 1 : 0
  type                     = "ingress"
  security_group_id        = aws_security_group.ecs_tasks.id
  from_port                = 3000
  to_port                  = 3000
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.router[0].id
}

resource "aws_instance" "router" {
  count         = var.enable_router_instance ? 1 : 0
  ami           = data.aws_ami.al2023.id
  instance_type = var.router_instance_type
  # Default VPC subnet ordering can include an AZ that doesn't support some instance types.
  # Prefer the 2nd subnet if present (commonly us-east-1a in default VPCs).
  subnet_id = length(local.public_subnet_ids) > 1 ? local.public_subnet_ids[1] : local.public_subnet_ids[0]

  vpc_security_group_ids = [aws_security_group.router[0].id]
  # When using an EIP, we don't need an ephemeral public IP. If the account is out of EIPs,
  # fall back to the instance public IP (set router_use_eip=false).
  associate_public_ip_address = var.router_use_eip ? false : true

  metadata_options {
    http_tokens = "required"
  }

  # user_data is only run on first boot; ensure updates replace the instance so
  # new bootstrap logic actually takes effect.
  user_data_replace_on_change = true

  user_data = <<-EOF
#!/bin/bash
set -euo pipefail
exec > >(tee /var/log/proofwork-router-user-data.log | tee /dev/console) 2>&1
set -x

# proofwork router bootstrap v3

dnf install -y nginx

# Nginx on AL2023 includes a default server block in /etc/nginx/nginx.conf that conflicts with
# any additional server blocks we write to /etc/nginx/conf.d/*.conf. Overwrite nginx.conf with
# a minimal config so our reverse proxy is definitely the active server on :80.
cat > /etc/nginx/nginx.conf <<'CONF'
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log;
pid /run/nginx.pid;

events {
  worker_connections 1024;
}

http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;

  access_log /var/log/nginx/access.log;

  sendfile on;
  keepalive_timeout 65;

  # Cloud Map + ECS tasks can change IPs; force periodic DNS re-resolution.
  resolver 169.254.169.253 valid=10s ipv6=off;
  resolver_timeout 2s;

  server {
    listen 80;
    server_name _;

    set $upstream "__UPSTREAM__";

    location / {
      proxy_pass $upstream;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      # Do not forward X-Forwarded-Proto from this HTTP-only router. The API uses this header
      # for HTTPS enforcement and cookie security; in router-mode we want it to behave as plain HTTP.
      proxy_set_header X-Forwarded-Proto "";
      proxy_set_header Connection "";
      proxy_read_timeout 60s;
    }
  }
}
CONF

sed -i "s|__UPSTREAM__|${local.api_internal_base}|g" /etc/nginx/nginx.conf

nginx -t
systemctl enable nginx
systemctl restart nginx
  EOF

  tags = {
    Name = "${local.name}-router"
  }
}

resource "aws_eip" "router" {
  count  = var.enable_router_instance && var.router_use_eip ? 1 : 0
  domain = "vpc"

  tags = {
    Name = "${local.name}-router-eip"
  }
}

resource "aws_eip_association" "router" {
  count         = var.enable_router_instance && var.router_use_eip ? 1 : 0
  instance_id   = aws_instance.router[0].id
  allocation_id = aws_eip.router[0].id
}
