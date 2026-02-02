import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from './types.js';

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/proofwork';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: DATABASE_URL,
});

export const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool }),
});

export async function closeDb() {
  await db.destroy();
  await pool.end();
}

