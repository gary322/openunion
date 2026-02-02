import { nanoid } from 'nanoid';
import { db } from './db/client.js';

export interface AuditEventInput {
  actorType: string;
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function writeAuditEvent(evt: AuditEventInput) {
  await db
    .insertInto('audit_log')
    .values({
      id: nanoid(12),
      actor_type: evt.actorType,
      actor_id: evt.actorId ?? null,
      action: evt.action,
      target_type: evt.targetType ?? null,
      target_id: evt.targetId ?? null,
      metadata: evt.metadata ?? {},
      created_at: new Date(),
    })
    .execute();
}

