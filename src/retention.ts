import { nanoid } from 'nanoid';
import { db } from './db/client.js';

export async function scheduleArtifactDeletion(artifactId: string, runAt: Date) {
  await db
    .insertInto('retention_jobs')
    .values({
      id: nanoid(12),
      artifact_id: artifactId,
      status: 'pending',
      run_at: runAt,
      attempts: 0,
      locked_at: null,
      locked_by: null,
      last_error: null,
      created_at: new Date(),
      finished_at: null,
    })
    .execute();
}

// Minimal scheduler: turn due retention jobs into outbox events. The actual deletion
// is performed by the retention worker (Phase 4).
export async function enqueueDueRetentionDeletions(now = new Date(), limit = 100) {
  const due = await db
    .selectFrom('retention_jobs')
    .select(['id', 'artifact_id'])
    .where('status', '=', 'pending')
    .where('run_at', '<=', now)
    .orderBy('run_at', 'asc')
    .limit(limit)
    .execute();

  for (const job of due) {
    // Mark enqueued (best-effort; idempotency handled in worker/outbox layer later)
    await db.updateTable('retention_jobs').set({ status: 'enqueued' }).where('id', '=', job.id).execute();

    await db
      .insertInto('outbox_events')
      .values({
        id: nanoid(12),
        topic: 'artifact.delete.requested',
        idempotency_key: `retention:${job.id}`,
        payload: { retentionJobId: job.id, artifactId: job.artifact_id },
        status: 'pending',
        attempts: 0,
        available_at: new Date(),
        locked_at: null,
        locked_by: null,
        last_error: null,
        created_at: new Date(),
        sent_at: null,
      })
      .onConflict((oc) => oc.columns(['topic', 'idempotency_key']).doNothing())
      .execute();
  }

  return due.length;
}

