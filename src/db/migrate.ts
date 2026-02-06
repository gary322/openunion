import path from 'path';
import { readdir, readFile } from 'fs/promises';
import { pool } from './client.js';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(migrationsDir = path.resolve(process.cwd(), 'db/migrations')): Promise<MigrationResult> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const appliedRows = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  const applied = new Set(appliedRows.rows.map((r: { filename: string }) => r.filename));

  const didApply: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (applied.has(file)) {
      skipped.push(file);
      continue;
    }

    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Concurrency-safe claim: multiple ECS services can start simultaneously and all call
      // runMigrations(). Claim the migration filename *first* so only one process runs the SQL.
      //
      // Unique index semantics ensure other contenders will block here and then no-op.
      const claimed = await client.query<{ filename: string }>(
        'INSERT INTO schema_migrations(filename) VALUES ($1) ON CONFLICT DO NOTHING RETURNING filename',
        [file]
      );
      if (claimed.rowCount === 0) {
        await client.query('ROLLBACK');
        skipped.push(file);
        continue;
      }

      await client.query(sql);
      await client.query('COMMIT');
      didApply.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return { applied: didApply, skipped };
}

if (process.env.NODE_ENV !== 'test' && import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then((res) => {
      console.log(`Migrations applied: ${res.applied.length}`);
      if (res.applied.length) console.log(res.applied.join('\n'));
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}
