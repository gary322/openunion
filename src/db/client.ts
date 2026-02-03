import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from './types.js';

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/proofwork';

const { Pool } = pg;

function wantDbSsl(): boolean {
  const v = String(process.env.DB_SSL ?? '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'require';
}

export const pool = new Pool({
  connectionString: DATABASE_URL,
  // RDS deployments can require SSL; keep dev/local default as plaintext.
  ...(wantDbSsl() ? { ssl: { rejectUnauthorized: false } } : {}),
});

export const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool }),
});

export async function closeDb() {
  await db.destroy();
  await pool.end();
}
