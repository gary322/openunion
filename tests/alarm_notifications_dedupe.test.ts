import { describe, it, expect, beforeEach } from 'vitest';
import { resetStore, insertAlarmNotification, listAlarmNotificationsAdmin } from '../src/store.js';

describe('alarm_notifications inbox', () => {
  beforeEach(async () => {
    await resetStore();
  });

  it('dedupes on (topic_arn, sns_message_id) using ON CONFLICT', async () => {
    const topicArn = 'arn:aws:sns:us-east-1:123:proofwork-staging-alarms';
    const snsMessageId = 'msg-1';

    await insertAlarmNotification({
      environment: 'staging',
      topicArn,
      snsMessageId,
      alarmName: 'canary',
      oldStateValue: 'OK',
      newStateValue: 'ALARM',
      stateReason: 'test',
      stateChangeTime: new Date(),
      raw: { hello: 'world' },
    });

    // SQS is at-least-once: inserting the same SNS message twice must not throw or duplicate.
    await insertAlarmNotification({
      environment: 'staging',
      topicArn,
      snsMessageId,
      alarmName: 'canary',
      oldStateValue: 'OK',
      newStateValue: 'ALARM',
      stateReason: 'test',
      stateChangeTime: new Date(),
      raw: { hello: 'world' },
    });

    const res = await listAlarmNotificationsAdmin({ limit: 50 });
    expect(res.total).toBe(1);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].snsMessageId).toBe(snsMessageId);
  });
});

