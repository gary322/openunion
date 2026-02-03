import { describe, it, expect } from 'vitest';
import { parseAlarmFromSns } from '../src/alerting/sns.js';

describe('parseAlarmFromSns', () => {
  it('extracts CloudWatch alarm fields from SNS envelope', () => {
    const env = {
      MessageId: 'msg-1',
      TopicArn: 'arn:aws:sns:us-east-1:123:topic',
      Message: JSON.stringify({
        AlarmName: 'proofwork-prod-api-cpu-high',
        OldStateValue: 'OK',
        NewStateValue: 'ALARM',
        NewStateReason: 'threshold crossed',
        StateChangeTime: '2026-02-03T00:00:00.000+0000',
      }),
    };

    const parsed = parseAlarmFromSns(env);
    expect(parsed.snsMessageId).toBe('msg-1');
    expect(parsed.topicArn).toBe('arn:aws:sns:us-east-1:123:topic');
    expect(parsed.alarmName).toBe('proofwork-prod-api-cpu-high');
    expect(parsed.oldStateValue).toBe('OK');
    expect(parsed.newStateValue).toBe('ALARM');
    expect(parsed.stateReason).toBe('threshold crossed');
    expect(parsed.stateChangeTime?.toISOString()).toBe('2026-02-03T00:00:00.000Z');
  });
});

