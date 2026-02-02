import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**', 'build/**'],
    // Shared Postgres DB is used by integration tests; avoid file-level parallelism.
    fileParallelism: false,
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
  },
});

