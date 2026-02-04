import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServer } from 'net';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { scanBytes } from '../src/scanner';

describe('clamd fallback (unix socket -> tcp)', () => {
  const prevEnv = { ...process.env };
  let dir = '';
  let server: ReturnType<typeof createServer> | null = null;
  let port = 0;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'proofwork-clamd-fallback-'));
    server = createServer((socket) => {
      socket.resume();
      socket.on('end', () => {
        socket.write('stream: OK\n');
        socket.end();
      });
    });

    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => {
        port = (server!.address() as any).port as number;
        resolve();
      });
    });
  });

  afterAll(async () => {
    // Restore env deterministically for other tests.
    for (const k of Object.keys(process.env)) {
      if (!(k in prevEnv)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(prevEnv)) process.env[k] = v;
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('falls back to TCP when CLAMD_SOCKET is set but missing', async () => {
    process.env.SCANNER_ENGINE = 'clamd';
    process.env.CLAMD_SOCKET = join(dir, 'missing.sock');
    process.env.CLAMD_HOST = '127.0.0.1';
    process.env.CLAMD_PORT = String(port);

    const res = await scanBytes({ bytes: Buffer.from('hello'), contentType: 'text/plain', filename: 'hello.txt' });
    expect(res.ok).toBe(true);
  }, 15_000);
});

