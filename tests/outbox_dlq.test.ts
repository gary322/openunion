import { describe, it, expect, beforeEach } from 'vitest';
import { pool } from '../src/db/client.js';
import { resetStore } from '../src/store.js';
import { markOutboxDead } from '../workers/outbox-lib.js';

describe('Outbox DLQ', () => {
  beforeEach(async () => {
    await resetStore();
  });

  it('marks events as deadletter when attempts exhausted', async () => {
    await pool.query(
      `INSERT INTO outbox_events(id, topic, idempotency_key, payload, status, attempts, available_at, created_at)
       VALUES ($1,'test.topic',NULL,'{}'::jsonb,'processing',9,now(),now())`,
      ['ob_test_1']
    );

    await markOutboxDead({ id: 'ob_test_1', error: new Error('boom') });

    const row = await pool.query<{ status: string; last_error: string | null }>(
      `SELECT status, last_error FROM outbox_events WHERE id=$1`,
      ['ob_test_1']
    );
    expect(row.rows[0].status).toBe('deadletter');
    expect(row.rows[0].last_error).toContain('boom');
  });
});

