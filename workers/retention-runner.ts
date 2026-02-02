// Load .env only in non-test environments
const _loadEnv = (process.env.NODE_ENV !== 'test' && !process.env.VITEST) 
  ? import('dotenv/config').catch(() => {}) 
  : Promise.resolve();
await _loadEnv;
import { runMigrations } from '../src/db/migrate.js';
import { enqueueDueRetentionDeletions } from '../src/retention.js';
import { runOutboxLoop } from './outbox-lib.js';
import { handleArtifactDeleteRequested } from './handlers.js';
import { startWorkerHealthServer } from './health.js';

const workerId = process.env.WORKER_ID ?? `retention-runner-${process.pid}`;

(async () => {
  await runMigrations();

  await startWorkerHealthServer({ name: 'retention-runner', portEnv: 'RETENTION_HEALTH_PORT', defaultPort: 9105 });

  // Periodically enqueue due retention deletions into outbox.
  setInterval(() => {
    enqueueDueRetentionDeletions().catch((err) => console.error('retention enqueue failed', err));
  }, 30_000);

  await runOutboxLoop({
    topics: ['artifact.delete.requested'],
    workerId,
    pollIntervalMs: 500,
    handler: async (evt) => {
      await handleArtifactDeleteRequested(evt.payload);
    },
  });
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

