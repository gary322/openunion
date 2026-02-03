locals {
  alarm_actions = var.alarm_sns_topic_arn != "" ? [var.alarm_sns_topic_arn] : []
}

resource "aws_cloudwatch_metric_alarm" "alb_target_5xx" {
  count               = var.enable_alb ? 1 : 0
  alarm_name          = "${local.name}-alb-target-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 5
  alarm_description   = "ALB target 5xx responses are elevated."

  dimensions = {
    LoadBalancer = aws_lb.api[0].arn_suffix
    TargetGroup  = aws_lb_target_group.api.arn_suffix
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "alb_target_response_time" {
  count               = var.enable_alb ? 1 : 0
  alarm_name          = "${local.name}-alb-latency"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  metric_name         = "TargetResponseTime"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Average"
  threshold           = 1
  alarm_description   = "ALB target response time is elevated."

  dimensions = {
    LoadBalancer = aws_lb.api[0].arn_suffix
    TargetGroup  = aws_lb_target_group.api.arn_suffix
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "ecs_api_cpu_high" {
  alarm_name          = "${local.name}-api-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "ECS API CPU utilization is high."

  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.api.name
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu_high" {
  alarm_name          = "${local.name}-rds-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "RDS CPU utilization is high."

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.postgres.id
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "rds_free_storage_low" {
  alarm_name          = "${local.name}-rds-free-storage-low"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 5
  metric_name         = "FreeStorageSpace"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 2147483648 # 2 GiB
  alarm_description   = "RDS free storage space is low."

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.postgres.id
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}
