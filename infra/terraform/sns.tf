locals {
  # Alarm notifications:
  # - If alarm_sns_topic_arn is provided, we use it (BYO topic).
  # - Otherwise, we can optionally create a topic in this module.
  effective_alarm_topic_arn = var.alarm_sns_topic_arn != "" ? var.alarm_sns_topic_arn : try(aws_sns_topic.alarms[0].arn, "")
}

resource "aws_sns_topic" "alarms" {
  count = var.create_alarm_sns_topic ? 1 : 0

  name = var.alarm_sns_topic_name != "" ? var.alarm_sns_topic_name : "${local.name}-alarms"
}

data "aws_iam_policy_document" "alarms_topic_policy" {
  count = var.create_alarm_sns_topic ? 1 : 0

  statement {
    sid     = "AllowCloudWatchToPublish"
    actions = ["sns:Publish"]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    resources = [aws_sns_topic.alarms[0].arn]
  }
}

resource "aws_sns_topic_policy" "alarms" {
  count  = var.create_alarm_sns_topic ? 1 : 0
  arn    = aws_sns_topic.alarms[0].arn
  policy = data.aws_iam_policy_document.alarms_topic_policy[0].json
}

resource "aws_sns_topic_subscription" "alarms_email" {
  for_each = var.create_alarm_sns_topic ? toset(var.alarm_email_subscriptions) : toset([])

  topic_arn = aws_sns_topic.alarms[0].arn
  protocol  = "email"
  endpoint  = each.value
}

resource "aws_sns_topic_subscription" "alarms_https" {
  for_each = var.create_alarm_sns_topic ? toset(var.alarm_https_subscriptions) : toset([])

  topic_arn = aws_sns_topic.alarms[0].arn
  protocol  = "https"
  endpoint  = each.value
}

