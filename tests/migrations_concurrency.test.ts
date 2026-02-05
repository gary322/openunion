import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { runMigrations } from '../src/db/migrate.js';

describe('runMigrations', () => {
  it('is concurrency-safe when multiple services start at once', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'migrations-concurrent-'));
    const file = `9999_smoke_concurrent_${Date.now()}.sql`;
    const table = `smoke_migrations_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      await writeFile(path.join(dir, file), `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY);\n`, 'utf8');

      const [a, b] = await Promise.all([runMigrations(dir), runMigrations(dir)]);
      const appliedCount = [...(a.applied ?? []), ...(b.applied ?? [])].filter((x) => x === file).length;
      expect(appliedCount).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

