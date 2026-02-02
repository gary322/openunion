// Load .env only in non-test environments
const _loadEnv =
  process.env.NODE_ENV !== 'test' && !process.env.VITEST ? import('dotenv/config').catch(() => {}) : Promise.resolve();
await _loadEnv;

import { runMigrations } from '../src/db/migrate.js';
import { runOutboxLoop } from './outbox-lib.js';
import { handleArtifactScanRequested } from './handlers.js';
import { startWorkerHealthServer } from './health.js';

const workerId = process.env.WORKER_ID ?? `scanner-runner-${process.pid}`;

(async () => {
  await runMigrations();

  await startWorkerHealthServer({ name: 'scanner-runner', portEnv: 'SCANNER_HEALTH_PORT', defaultPort: 9104 });

  await runOutboxLoop({
    topics: ['artifact.scan.requested'],
    workerId,
    pollIntervalMs: 500,
    handler: async (evt) => {
      await handleArtifactScanRequested(evt.payload);
    },
  });
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

