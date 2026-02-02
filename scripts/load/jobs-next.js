import autocannon from 'autocannon';

const base = (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const token = process.env.WORKER_TOKEN;
if (!token) {
  console.error('Set WORKER_TOKEN env var (from /api/workers/register) before running load test.');
  process.exit(1);
}

const url = `${base}/api/jobs/next`;

const instance = autocannon({
  url,
  connections: Number(process.env.LOAD_CONNECTIONS ?? 20),
  duration: Number(process.env.LOAD_DURATION_SEC ?? 10),
  headers: {
    Authorization: `Bearer ${token}`,
  },
});

autocannon.track(instance, { renderProgressBar: true });

