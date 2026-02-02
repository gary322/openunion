// Load .env only in non-test environments
const _loadEnv = (process.env.NODE_ENV !== 'test' && !process.env.VITEST) 
  ? import('dotenv/config').catch(() => {}) 
  : Promise.resolve();
await _loadEnv;
import { runMigrations } from '../src/db/migrate.js';
import { runOutboxLoop } from './outbox-lib.js';
import { handleVerificationRequested } from './handlers.js';
import { startWorkerHealthServer } from './health.js';

const workerId = process.env.WORKER_ID ?? `verification-runner-${process.pid}`;

(async () => {
  await runMigrations();

  await startWorkerHealthServer({ name: 'verification-runner', portEnv: 'VERIFICATION_HEALTH_PORT', defaultPort: 9102 });

  await runOutboxLoop({
    topics: ['verification.requested'],
    workerId,
    pollIntervalMs: 500,
    handler: async (evt) => {
      await handleVerificationRequested(evt.payload);
    },
  });
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

