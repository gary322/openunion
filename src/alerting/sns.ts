export type SnsEnvelope = {
  Type?: string;
  MessageId?: string;
  TopicArn?: string;
  Message?: string;
  Timestamp?: string;
};

export type CloudWatchAlarmMessage = {
  AlarmName?: string;
  OldStateValue?: string;
  NewStateValue?: string;
  NewStateReason?: string;
  StateChangeTime?: string;
};

function safeJsonParse(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function parseAlarmFromSns(envelope: SnsEnvelope): {
  snsMessageId: string | null;
  topicArn: string;
  alarmName: string | null;
  oldStateValue: string | null;
  newStateValue: string | null;
  stateReason: string | null;
  stateChangeTime: Date | null;
  raw: any;
} {
  const snsMessageId = envelope.MessageId ? String(envelope.MessageId) : null;
  const topicArn = String(envelope.TopicArn ?? '');
  const rawOuter = envelope as any;

  const innerRaw = envelope.Message ? safeJsonParse(String(envelope.Message)) : null;
  const alarm = (innerRaw ?? {}) as CloudWatchAlarmMessage;

  const alarmName = alarm.AlarmName ? String(alarm.AlarmName) : null;
  const oldStateValue = alarm.OldStateValue ? String(alarm.OldStateValue) : null;
  const newStateValue = alarm.NewStateValue ? String(alarm.NewStateValue) : null;
  const stateReason = alarm.NewStateReason ? String(alarm.NewStateReason) : null;
  const stateChangeTime = alarm.StateChangeTime ? new Date(String(alarm.StateChangeTime)) : null;

  return {
    snsMessageId,
    topicArn,
    alarmName,
    oldStateValue,
    newStateValue,
    stateReason,
    stateChangeTime: stateChangeTime && !Number.isNaN(stateChangeTime.getTime()) ? stateChangeTime : null,
    raw: { sns: rawOuter, message: innerRaw },
  };
}

