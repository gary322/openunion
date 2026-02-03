import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServer } from 'net';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { scanBytes } from '../src/scanner';

describe('clamd unix socket', () => {
  const prevEnv = { ...process.env };
  let dir = '';
  let sockPath = '';
  let server: ReturnType<typeof createServer> | null = null;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'proofwork-clamd-sock-'));
    sockPath = join(dir, 'clamd.sock');

    server = createServer((socket) => {
      // We only need a minimal protocol stub:
      // - accept the zINSTREAM payload
      // - after client finishes writing, respond with OK
      socket.resume(); // ensure 'end' fires even if we don't process data frames
      socket.on('end', () => {
        socket.write('stream: OK\n');
        socket.end();
      });
    });

    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(sockPath, () => resolve());
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

  it('scans via unix socket when CLAMD_SOCKET is set', async () => {
    process.env.SCANNER_ENGINE = 'clamd';
    process.env.CLAMD_SOCKET = sockPath;

    const res = await scanBytes({ bytes: Buffer.from('hello'), contentType: 'text/plain', filename: 'hello.txt' });
    expect(res.ok).toBe(true);
  }, 15_000);
});
