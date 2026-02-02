// Load .env only in non-test environments
const _loadEnv = (process.env.NODE_ENV !== 'test' && !process.env.VITEST) 
  ? import('dotenv/config').catch(() => {}) 
  : Promise.resolve();
await _loadEnv;
import { runMigrations } from '../src/db/migrate.js';
import { runOutboxLoop } from './outbox-lib.js';
import {
  handleArtifactDeleteRequested,
  handleArtifactScanRequested,
  handlePayoutConfirmRequested,
  handlePayoutRequested,
  handleVerificationRequested,
} from './handlers.js';
import { startWorkerHealthServer } from './health.js';

const workerId = process.env.WORKER_ID ?? `outbox-dispatcher-${process.pid}`;
const topics = ['verification.requested', 'payout.requested', 'payout.confirm.requested', 'artifact.scan.requested', 'artifact.delete.requested'];

(async () => {
  await runMigrations();

  await startWorkerHealthServer({ name: 'outbox-dispatcher', portEnv: 'OUTBOX_HEALTH_PORT', defaultPort: 9101 });

  await runOutboxLoop({
    topics,
    workerId,
    pollIntervalMs: 500,
    handler: async (evt) => {
      if (evt.topic === 'verification.requested') return await handleVerificationRequested(evt.payload);
      if (evt.topic === 'payout.requested') return await handlePayoutRequested(evt.payload);
      if (evt.topic === 'payout.confirm.requested') return await handlePayoutConfirmRequested(evt.payload);
      if (evt.topic === 'artifact.scan.requested') return await handleArtifactScanRequested(evt.payload);
      if (evt.topic === 'artifact.delete.requested') return await handleArtifactDeleteRequested(evt.payload);
      throw new Error(`unknown_topic:${evt.topic}`);
    },
  });
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

