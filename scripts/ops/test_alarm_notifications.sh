#!/usr/bin/env bash
set -euo pipefail

# End-to-end alarm notification test:
# CloudWatch Alarm -> SNS -> SQS subscription.
#
# Why SQS?
# - Fully automatable (no manual email confirmation)
# - Verifies SNS publish and delivery end-to-end
#
# Usage:
#   bash scripts/ops/test_alarm_notifications.sh staging arn:aws:sns:...:proofwork-staging-alarms us-east-1

ENVIRONMENT="${1:-}"
TOPIC_ARN="${2:-}"
AWS_REGION="${3:-us-east-1}"

if [[ -z "$ENVIRONMENT" || -z "$TOPIC_ARN" ]]; then
  echo "usage: $0 <staging|prod> <sns_topic_arn> [aws_region]" >&2
  exit 1
fi

ts="$(date +%Y%m%d%H%M%S)"
QUEUE_NAME="proofwork-${ENVIRONMENT}-alarms-canary-${ts}"
ALARM_NAME="proofwork-${ENVIRONMENT}-alarms-canary-${ts}"
NAMESPACE="ProofworkCanary"
METRIC_NAME="AlarmCanary"

cleanup() {
  set +e
  if [[ -n "${ALARM_NAME:-}" ]]; then
    aws cloudwatch delete-alarms --region "$AWS_REGION" --alarm-names "$ALARM_NAME" >/dev/null 2>&1 || true
  fi
  if [[ -n "${SUB_ARN:-}" && "${SUB_ARN:-}" != "None" ]]; then
    aws sns unsubscribe --region "$AWS_REGION" --subscription-arn "$SUB_ARN" >/dev/null 2>&1 || true
  fi
  if [[ -n "${QUEUE_URL:-}" ]]; then
    aws sqs delete-queue --region "$AWS_REGION" --queue-url "$QUEUE_URL" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "[alarm_test] env=$ENVIRONMENT region=$AWS_REGION topic=$TOPIC_ARN"

echo "[alarm_test] creating SQS queue..."
QUEUE_URL="$(aws sqs create-queue --region "$AWS_REGION" --queue-name "$QUEUE_NAME" --query QueueUrl --output text)"
QUEUE_ARN="$(aws sqs get-queue-attributes --region "$AWS_REGION" --queue-url "$QUEUE_URL" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)"

echo "[alarm_test] setting SQS policy for SNS delivery..."
POLICY="$(jq -nc --arg qarn "$QUEUE_ARN" --arg tarn "$TOPIC_ARN" '{
  Version: "2012-10-17",
  Statement: [{
    Sid: "AllowSnsPublish",
    Effect: "Allow",
    Principal: { Service: "sns.amazonaws.com" },
    Action: "sqs:SendMessage",
    Resource: $qarn,
    Condition: { ArnEquals: { "aws:SourceArn": $tarn } }
  }]
}')"
aws sqs set-queue-attributes \
  --region "$AWS_REGION" \
  --cli-input-json "$(jq -nc --arg url "$QUEUE_URL" --arg policy "$POLICY" '{QueueUrl:$url,Attributes:{Policy:$policy}}')" >/dev/null

echo "[alarm_test] subscribing queue to SNS topic..."
SUB_ARN="$(aws sns subscribe --region "$AWS_REGION" --topic-arn "$TOPIC_ARN" --protocol sqs --notification-endpoint "$QUEUE_ARN" --return-subscription-arn --query SubscriptionArn --output text)"

echo "[alarm_test] creating canary CloudWatch alarm..."
aws cloudwatch put-metric-alarm \
  --region "$AWS_REGION" \
  --alarm-name "$ALARM_NAME" \
  --alarm-description "Canary alarm for SNS delivery test (${ENVIRONMENT})" \
  --namespace "$NAMESPACE" \
  --metric-name "$METRIC_NAME" \
  --statistic Maximum \
  --period 60 \
  --evaluation-periods 1 \
  --threshold 0 \
  --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions "$TOPIC_ARN" >/dev/null

echo "[alarm_test] forcing alarm state to ALARM to trigger notification..."
aws cloudwatch set-alarm-state --region "$AWS_REGION" --alarm-name "$ALARM_NAME" --state-value ALARM --state-reason "canary-test" >/dev/null

echo "[alarm_test] waiting for message in SQS..."
for i in 1 2 3 4 5 6; do
  BODY="$(aws sqs receive-message --region "$AWS_REGION" --queue-url "$QUEUE_URL" --wait-time-seconds 20 --max-number-of-messages 1 --query 'Messages[0].Body' --output text 2>/dev/null || true)"
  if [[ -n "$BODY" && "$BODY" != "None" ]]; then
    # SNS->SQS envelope: Body.Message is a JSON string containing AlarmName etc.
    GOT_ALARM="$(jq -r '.Message' <<<"$BODY" | jq -r '.AlarmName' 2>/dev/null || true)"
    if [[ "$GOT_ALARM" == "$ALARM_NAME" ]]; then
      echo "[alarm_test] OK (received alarm notification for $ALARM_NAME)"
      exit 0
    fi
  fi
  echo "[alarm_test] retry $i/6..."
done

echo "[alarm_test] ERROR: did not receive alarm notification via SNS->SQS" >&2
exit 1
