import { beforeAll, describe, expect, it } from 'vitest';
import { scanBytes } from '../src/scanner.js';

async function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForClamdReady(timeoutMs = 60_000) {
  const host = process.env.CLAMD_HOST ?? '127.0.0.1';
  const port = Number(process.env.CLAMD_PORT ?? 3310);
  const { connect } = await import('net');

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = connect({ host, port }, () => {
        sock.write('PING\n');
      });
      sock.setTimeout(2000);
      let resp = '';
      sock.on('data', (d) => (resp += d.toString('utf8')));
      const done = (v: boolean) => {
        try {
          sock.destroy();
        } catch {
          // ignore
        }
        resolve(v);
      };
      sock.on('timeout', () => done(false));
      sock.on('error', () => done(false));
      sock.on('close', () => done(resp.toUpperCase().includes('PONG')));
    });

    if (ok) return;
    await wait(500);
  }
  throw new Error('clamd_not_ready');
}

const enabled = process.env.RUN_CLAMD_TESTS === '1';

(enabled ? describe : describe.skip)('ClamAV (clamd) scanning', () => {
  beforeAll(async () => {
    process.env.SCANNER_ENGINE = 'clamd';
    process.env.CLAMD_HOST = process.env.CLAMD_HOST ?? '127.0.0.1';
    process.env.CLAMD_PORT = process.env.CLAMD_PORT ?? '3310';
    process.env.CLAMD_TIMEOUT_MS = process.env.CLAMD_TIMEOUT_MS ?? '15000';
    await waitForClamdReady();
  });

  it('passes clean bytes', async () => {
    const res = await scanBytes({ bytes: Buffer.from('hello world\n'), contentType: 'text/plain', filename: 'hello.txt' });
    expect(res.ok).toBe(true);
  });

  it('blocks EICAR test string', async () => {
    const eicar =
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    const res = await scanBytes({ bytes: Buffer.from(eicar, 'utf8'), contentType: 'text/plain', filename: 'eicar.txt' });
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toContain('clamd');
  });
});

