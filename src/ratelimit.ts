import { pool } from './db/client.js';

export async function rateLimit(key: string, ratePerMin: number): Promise<boolean> {
  const now = new Date();
  const fillPerMs = ratePerMin / 60000;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ensure the bucket row exists before attempting SELECT ... FOR UPDATE.
    // Without this, concurrent first-use requests can race and both attempt INSERT,
    // causing a unique violation (23505) and returning 500 to callers.
    await client.query(
      'INSERT INTO rate_limit_buckets(key, tokens, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING',
      [key, ratePerMin, now]
    );

    const rowRes = await client.query<{ tokens: number; updated_at: Date }>(
      'SELECT tokens, updated_at FROM rate_limit_buckets WHERE key = $1 FOR UPDATE',
      [key]
    );

    if (rowRes.rowCount === 0) throw new Error('rate_limit_bucket_missing');
    let tokens = Number(rowRes.rows[0].tokens);
    let updatedAt = rowRes.rows[0].updated_at;

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
