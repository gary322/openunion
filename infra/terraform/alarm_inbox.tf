locals {
  alarm_inbox_enabled = var.enable_alarm_inbox && local.effective_alarm_topic_arn != ""
}

resource "aws_sqs_queue" "alarm_inbox" {
  count = local.alarm_inbox_enabled ? 1 : 0

  name                       = "${local.name}-alarm-inbox"
  message_retention_seconds  = var.alarm_inbox_retention_seconds
  visibility_timeout_seconds = 60
}

data "aws_iam_policy_document" "alarm_inbox_queue_policy" {
  count = local.alarm_inbox_enabled ? 1 : 0

  statement {
    sid     = "AllowSnsPublish"
    actions = ["sqs:SendMessage"]
    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }
    resources = [aws_sqs_queue.alarm_inbox[0].arn]
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [local.effective_alarm_topic_arn]
    }
  }
}

resource "aws_sqs_queue_policy" "alarm_inbox" {
  count = local.alarm_inbox_enabled ? 1 : 0

  queue_url = aws_sqs_queue.alarm_inbox[0].url
  policy    = data.aws_iam_policy_document.alarm_inbox_queue_policy[0].json
}

resource "aws_sns_topic_subscription" "alarm_inbox" {
  count = local.alarm_inbox_enabled ? 1 : 0

  topic_arn = local.effective_alarm_topic_arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.alarm_inbox[0].arn
}

