import { pool } from '../src/db/client.js';

export interface OutboxEvent {
  id: string;
  topic: string;
  payload: any;
  attempts: number;
}

const MAX_OUTBOX_ATTEMPTS = Number(process.env.MAX_OUTBOX_ATTEMPTS ?? 10);
const OUTBOX_LOCK_TIMEOUT_SEC = Number(process.env.OUTBOX_LOCK_TIMEOUT_SEC ?? 600);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function claimOutboxBatch(input: { topics: string[]; workerId: string; limit?: number }): Promise<OutboxEvent[]> {
  const limit = input.limit ?? 25;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Release stale locks (crashed workers) so events can be retried.
    await client.query(
      `
      UPDATE outbox_events
      SET status = 'pending',
          locked_at = NULL,
          locked_by = NULL
      WHERE status = 'processing'
        AND locked_at IS NOT NULL
        AND locked_at < now() - (interval '1 second' * $1)
      `,
      [OUTBOX_LOCK_TIMEOUT_SEC]
    );

    const res = await client.query(
      `
      SELECT id, topic, payload, attempts
      FROM outbox_events
      WHERE status = 'pending'
        AND available_at <= now()
        AND topic = ANY($1)
      ORDER BY created_at
      LIMIT $2
      FOR UPDATE SKIP LOCKED
      `,
      [input.topics, limit]
    );

    const ids: string[] = res.rows.map((r: any) => r.id);
    if (ids.length) {
      await client.query(
        `
        UPDATE outbox_events
        SET status = 'processing',
            locked_at = now(),
            locked_by = $1,
            attempts = attempts + 1
        WHERE id = ANY($2)
        `,
        [input.workerId, ids]
      );
    }

    await client.query('COMMIT');
    // attempts returned by SELECT is the previous value; we incremented it in the UPDATE above.
    return (res.rows as any[]).map((r) => ({ ...r, attempts: Number(r.attempts ?? 0) + 1 })) as OutboxEvent[];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function markOutboxSent(id: string) {
  await pool.query(
    `
    UPDATE outbox_events
    SET status = 'sent',
        sent_at = now(),
        locked_at = NULL,
        locked_by = NULL
    WHERE id = $1
    `,
    [id]
  );
}

export async function rescheduleOutbox(input: { id: string; error: unknown; delaySec: number }) {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  await pool.query(
    `
    UPDATE outbox_events
    SET status = 'pending',
        last_error = $2,
        available_at = now() + (interval '1 second' * $3),
        locked_at = NULL,
        locked_by = NULL
    WHERE id = $1
    `,
    [input.id, message.slice(0, 5000), input.delaySec]
  );
}

export async function markOutboxDead(input: { id: string; error: unknown }) {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  await pool.query(
    `
    UPDATE outbox_events
    SET status = 'deadletter',
        last_error = $2,
        locked_at = NULL,
        locked_by = NULL
    WHERE id = $1
    `,
    [input.id, message.slice(0, 5000)]
  );
}

export function backoffSeconds(attemptNo: number) {
  // attemptNo starts at 1
  const base = Math.min(60, 2 ** Math.min(10, Math.max(0, attemptNo - 1)));
  return base;
}

export async function runOutboxLoop(input: {
  topics: string[];
  workerId: string;
  pollIntervalMs?: number;
  limit?: number;
  handler: (evt: OutboxEvent) => Promise<void>;
}) {
  const pollIntervalMs = input.pollIntervalMs ?? 500;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await claimOutboxBatch({ topics: input.topics, workerId: input.workerId, limit: input.limit });
    if (batch.length === 0) {
      await sleep(pollIntervalMs);
      continue;
    }

    for (const evt of batch) {
      try {
        await input.handler(evt);
        await markOutboxSent(evt.id);
      } catch (err) {
        const attemptNo = Number(evt.attempts ?? 1);
        if (attemptNo >= MAX_OUTBOX_ATTEMPTS) {
          await markOutboxDead({ id: evt.id, error: err });
          continue;
        }
        await rescheduleOutbox({ id: evt.id, error: err, delaySec: backoffSeconds(attemptNo) });
      }
    }
  }
}

