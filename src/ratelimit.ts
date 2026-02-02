import { pool } from './db/client.js';

export async function rateLimit(key: string, ratePerMin: number): Promise<boolean> {
  const now = new Date();
  const fillPerMs = ratePerMin / 60000;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const rowRes = await client.query<{ tokens: number; updated_at: Date }>(
      'SELECT tokens, updated_at FROM rate_limit_buckets WHERE key = $1 FOR UPDATE',
      [key]
    );

    let tokens = ratePerMin;
    let updatedAt = now;
    if (rowRes.rowCount === 0) {
      await client.query('INSERT INTO rate_limit_buckets(key, tokens, updated_at) VALUES ($1, $2, $3)', [key, ratePerMin, now]);
      tokens = ratePerMin;
      updatedAt = now;
    } else {
      tokens = Number(rowRes.rows[0].tokens);
      updatedAt = rowRes.rows[0].updated_at;
    }

    const elapsedMs = now.getTime() - updatedAt.getTime();
    tokens = Math.min(ratePerMin, tokens + elapsedMs * fillPerMs);

    if (tokens < 1) {
      await client.query('UPDATE rate_limit_buckets SET tokens = $2, updated_at = $3 WHERE key = $1', [key, tokens, now]);
      await client.query('COMMIT');
      return false;
    }

    tokens -= 1;
    await client.query('UPDATE rate_limit_buckets SET tokens = $2, updated_at = $3 WHERE key = $1', [key, tokens, now]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
