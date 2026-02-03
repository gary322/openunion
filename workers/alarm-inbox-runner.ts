// Load .env only in non-test environments
const _loadEnv =
  process.env.NODE_ENV !== 'test' && !process.env.VITEST ? import('dotenv/config').catch(() => {}) : Promise.resolve();
await _loadEnv;

import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { runMigrations } from '../src/db/migrate.js';
import { insertAlarmNotification, pruneAlarmNotifications } from '../src/store.js';
import { startWorkerHealthServer } from './health.js';
import { inc } from '../src/metrics.js';
import { parseAlarmFromSns, type SnsEnvelope } from '../src/alerting/sns.js';

function mustEnv(name: string): string {
  const v = String(process.env[name] ?? '').trim();
  if (!v) throw new Error(`missing_${name}`);
  return v;
}

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.floor(raw);
}

function safeJsonParse(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function main() {
  await runMigrations();

  await startWorkerHealthServer({ name: 'alarm-inbox-runner', portEnv: 'ALARM_INBOX_HEALTH_PORT', defaultPort: 9106 });

  const workerId = process.env.WORKER_ID ?? `alarm-inbox-runner-${process.pid}`;
  const queueUrl = mustEnv('ALARM_INBOX_QUEUE_URL');
  const environment = String(process.env.ENVIRONMENT ?? process.env.APP_ENV ?? '').trim() || 'unknown';

  const maxMessages = Math.max(1, Math.min(10, envInt('ALARM_INBOX_MAX_MESSAGES', 5)));
  const waitSeconds = Math.max(0, Math.min(20, envInt('ALARM_INBOX_WAIT_SECONDS', 10)));
  const visibilityTimeout = Math.max(10, Math.min(300, envInt('ALARM_INBOX_VISIBILITY_TIMEOUT', 60)));
  const pollSleepMs = Math.max(0, Math.min(5_000, envInt('ALARM_INBOX_POLL_SLEEP_MS', 250)));

  const pruneDays = Math.max(1, Math.min(365, envInt('ALARM_INBOX_TTL_DAYS', 30)));
  setInterval(() => {
    pruneAlarmNotifications({ maxAgeDays: pruneDays }).catch(() => {});
  }, 60 * 60 * 1000).unref?.();

  const region = String(process.env.AWS_REGION ?? process.env.S3_REGION ?? 'us-east-1');
  const sqs = new SQSClient({ region });

  // eslint-disable-next-line no-console
  console.log(`[alarm_inbox] workerId=${workerId} env=${environment} region=${region} queue=${queueUrl}`);

  while (true) {
    const resp = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds: waitSeconds,
        VisibilityTimeout: visibilityTimeout,
      })
    );

    const msgs = resp.Messages ?? [];
    if (msgs.length === 0) {
      if (pollSleepMs) await new Promise((r) => setTimeout(r, pollSleepMs));
      continue;
    }

    for (const m of msgs) {
      const receipt = m.ReceiptHandle;
      const body = String(m.Body ?? '');
      const env = safeJsonParse(body) as SnsEnvelope | null;
      if (!receipt) continue;
      if (!env || !env.TopicArn) {
        // Drop malformed messages to avoid re-delivery loops.
        await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receipt }));
        continue;
      }

      try {
        const parsed = parseAlarmFromSns(env);
        await insertAlarmNotification({
          environment,
          topicArn: parsed.topicArn,
          snsMessageId: parsed.snsMessageId,
          alarmName: parsed.alarmName,
          oldStateValue: parsed.oldStateValue,
          newStateValue: parsed.newStateValue,
          stateReason: parsed.stateReason,
          stateChangeTime: parsed.stateChangeTime,
          raw: parsed.raw,
        });
        inc('alarm_notifications_ingested_total', 1);
      } catch (err: any) {
        // eslint-disable-next-line no-console
        console.error(`[alarm_inbox] insert_failed msgId=${env.MessageId ?? 'unknown'} err=${String(err?.message ?? err)}`);
      }

      // Delete regardless of insert success to avoid an infinite redelivery loop.
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receipt }));
    }
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
