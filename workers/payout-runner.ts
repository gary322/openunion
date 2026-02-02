// Load .env only in non-test environments
const _loadEnv = (process.env.NODE_ENV !== 'test' && !process.env.VITEST) 
  ? import('dotenv/config').catch(() => {}) 
  : Promise.resolve();
await _loadEnv;
import { runMigrations } from '../src/db/migrate.js';
import { runOutboxLoop } from './outbox-lib.js';
import { handlePayoutConfirmRequested, handlePayoutRequested } from './handlers.js';
import { startWorkerHealthServer } from './health.js';

const workerId = process.env.WORKER_ID ?? `payout-runner-${process.pid}`;

(async () => {
  await runMigrations();

  await startWorkerHealthServer({ name: 'payout-runner', portEnv: 'PAYOUT_HEALTH_PORT', defaultPort: 9103 });

  await runOutboxLoop({
    topics: ['payout.requested', 'payout.confirm.requested'],
    workerId,
    pollIntervalMs: 500,
    handler: async (evt) => {
      if (evt.topic === 'payout.requested') return await handlePayoutRequested(evt.payload);
      if (evt.topic === 'payout.confirm.requested') return await handlePayoutConfirmRequested(evt.payload);
      throw new Error(`unknown_topic:${evt.topic}`);
    },
  });
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

