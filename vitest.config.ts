import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**', 'build/**', 'var/**'],
    // Many tests share a single DB/store; keep execution single-worker to avoid cross-test races.
    fileParallelism: false,
    maxWorkers: 1,
  },
});
