import Fastify from 'fastify';

export async function startWorkerHealthServer(input: {
  name: string;
  portEnv: string;
  defaultPort: number;
  getStatus?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
}) {
  const port = Number(process.env[input.portEnv] ?? input.defaultPort);
  const host = process.env.WORKER_HEALTH_HOST ?? '0.0.0.0';
  const app = Fastify({ logger: false });

  app.get('/health', async () => ({ ok: true, name: input.name, pid: process.pid }));
  app.get('/health/status', async () => {
    const extra = input.getStatus ? await input.getStatus() : {};
    return { ok: true, name: input.name, pid: process.pid, ...extra };
  });

  await app.listen({ port, host });
  return { port, host };
}

