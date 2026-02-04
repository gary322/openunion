import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import plugin, { __internal } from '../integrations/openclaw/plugins/proofwork-worker/index.js';

type Logger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void; debug: (msg: string) => void };

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function makeStubWorker(params: { dir: string; kind: 'stay_alive' | 'exit_1' }): Promise<string> {
  const p = join(params.dir, `stub-worker-${params.kind}.mjs`);
  const code = `import fs from "node:fs/promises";
import { dirname, join as pJoin } from "node:path";

const statusFile = process.env.PROOFWORK_STATUS_FILE;
async function bump() {
  if (!statusFile) return;
  await fs.mkdir(dirname(statusFile), { recursive: true });
  let cur = {};
  try {
    const raw = await fs.readFile(statusFile, "utf8");
    cur = raw ? JSON.parse(raw) : {};
  } catch {
    cur = {};
  }
  const n = Number(cur.runCount ?? 0) + 1;
  const next = { ...cur, runCount: n, lastPid: process.pid, lastStartedAt: Date.now() };
  const tmp = pJoin(dirname(statusFile), ".tmp-" + process.pid + "-" + Date.now() + ".json");
  await fs.writeFile(tmp, JSON.stringify(next) + "\\n", { mode: 0o600 });
  await fs.rename(tmp, statusFile);
}

await bump();

${params.kind === 'exit_1' ? 'process.exit(1);' : 'setInterval(() => {}, 1000);'}
`;
  await writeFile(p, code, 'utf8');
  await chmod(p, 0o755);
  return p;
}

function makeLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (lvl: string, msg: string) => lines.push(`[${lvl}] ${msg}`);
  return {
    lines,
    logger: {
      info: (m) => push('info', m),
      warn: (m) => push('warn', m),
      error: (m) => push('error', m),
      debug: (m) => push('debug', m),
    },
  };
}

describe('OpenClaw Proofwork Worker plugin (service + commands)', () => {
  it('starts a worker, enforces single-instance lock, and stops cleanly', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'openclaw-state-'));
    const workspaceDir = await mkdtemp(join(tmpdir(), 'openclaw-ws-'));
    const stubDir = await mkdtemp(join(tmpdir(), 'openclaw-stub-'));
    const workerScriptPath = await makeStubWorker({ dir: stubDir, kind: 'stay_alive' });

    const { logger, lines } = makeLogger();
    let service: any = null;
    let command: any = null;

    plugin.register({
      id: 'proofwork-worker',
      pluginConfig: { apiBaseUrl: 'http://127.0.0.1:1', workerScriptPath },
      logger,
      registerService: (s: any) => {
        service = s;
      },
      registerCommand: (c: any) => {
        command = c;
      },
    } as any);

    expect(service?.start).toBeTypeOf('function');
    expect(service?.stop).toBeTypeOf('function');
    expect(command?.handler).toBeTypeOf('function');

    const ctx = { config: {}, stateDir, workspaceDir, logger };
    const paths = __internal.computeStateRoot({ stateDir, workspaceDir });
    const lockFile = join(paths.root, 'lock.json');
    const statusFile = join(paths.root, 'status.json');

    await service.start(ctx);
    await sleep(150);
    expect(await readFile(lockFile, 'utf8')).toContain('"pid"');

    // Second start should be a no-op due to single-instance lock.
    await service.start(ctx);
    await sleep(150);
    const statusRaw = await readFile(statusFile, 'utf8');
    const status = JSON.parse(statusRaw);
    expect(Number(status.runCount ?? 0)).toBe(1);

    await service.stop(ctx);
    await sleep(150);

    // Ensure the service reports stopped.
    const statusText = await command.handler({ args: 'status' });
    expect(String(statusText.text)).toContain('running: false');

    // Best-effort: lock file should be removed on stop.
    let lockStillThere = true;
    try {
      await readFile(lockFile, 'utf8');
    } catch {
      lockStillThere = false;
    }
    expect(lockStillThere).toBe(false);

    // Not strictly asserted, but helpful if failures occur.
    expect(lines.length).toBeGreaterThan(0);
  });

  it('restarts worker after crash (exponential backoff)', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'openclaw-state-'));
    const workspaceDir = await mkdtemp(join(tmpdir(), 'openclaw-ws-'));
    const stubDir = await mkdtemp(join(tmpdir(), 'openclaw-stub-'));
    const workerScriptPath = await makeStubWorker({ dir: stubDir, kind: 'exit_1' });

    const { logger } = makeLogger();
    let service: any = null;

    plugin.register({
      id: 'proofwork-worker',
      pluginConfig: { apiBaseUrl: 'http://127.0.0.1:1', workerScriptPath },
      logger,
      registerService: (s: any) => {
        service = s;
      },
      registerCommand: () => {},
    } as any);

    const ctx = { config: {}, stateDir, workspaceDir, logger };
    const paths = __internal.computeStateRoot({ stateDir, workspaceDir });
    const statusFile = join(paths.root, 'status.json');

    await service.start(ctx);
    // First run writes status quickly, second run happens after ~2s backoff.
    await sleep(3200);

    const raw = await readFile(statusFile, 'utf8');
    const status = JSON.parse(raw);
    expect(Number(status.runCount ?? 0)).toBeGreaterThanOrEqual(2);

    await service.stop(ctx);
  });

  it('supports pause/resume and token rotate commands', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'openclaw-state-'));
    const workspaceDir = await mkdtemp(join(tmpdir(), 'openclaw-ws-'));
    const stubDir = await mkdtemp(join(tmpdir(), 'openclaw-stub-'));
    const workerScriptPath = await makeStubWorker({ dir: stubDir, kind: 'stay_alive' });

    const { logger } = makeLogger();
    let service: any = null;
    let command: any = null;

    plugin.register({
      id: 'proofwork-worker',
      pluginConfig: { apiBaseUrl: 'http://127.0.0.1:1', workerScriptPath },
      logger,
      registerService: (s: any) => {
        service = s;
      },
      registerCommand: (c: any) => {
        command = c;
      },
    } as any);

    const ctx = { config: {}, stateDir, workspaceDir, logger };
    const paths = __internal.computeStateRoot({ stateDir, workspaceDir });
    const tokenFile = join(paths.root, 'worker-token.json');
    const pauseFile = join(paths.root, 'pause.flag');
    const statusFile = join(paths.root, 'status.json');

    await service.start(ctx);
    await sleep(150);

    // Seed a token file so rotate can remove it.
    await writeFile(tokenFile, JSON.stringify({ workerId: 'w', token: 't' }) + '\n', { mode: 0o600 });

    const paused = await command.handler({ args: 'pause' });
    expect(String(paused.text)).toContain('paused');

    let pauseExists = false;
    try {
      await readFile(pauseFile, 'utf8');
      pauseExists = true;
    } catch {
      pauseExists = false;
    }
    expect(pauseExists).toBe(true);

    const resumed = await command.handler({ args: 'resume' });
    expect(String(resumed.text)).toContain('resumed');
    await sleep(200);

    const statusAfter = JSON.parse(await readFile(statusFile, 'utf8'));
    expect(Number(statusAfter.runCount ?? 0)).toBeGreaterThanOrEqual(2);

    const rotated = await command.handler({ args: 'token rotate' });
    expect(String(rotated.text)).toContain('token rotated');

    let tokenStillThere = true;
    try {
      await readFile(tokenFile, 'utf8');
    } catch {
      tokenStillThere = false;
    }
    expect(tokenStillThere).toBe(false);

    await service.stop(ctx);
  });

  it('supports payout commands (status/message/set) using the persisted worker token', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'openclaw-state-'));
    const workspaceDir = await mkdtemp(join(tmpdir(), 'openclaw-ws-'));
    const stubDir = await mkdtemp(join(tmpdir(), 'openclaw-stub-'));
    const workerScriptPath = await makeStubWorker({ dir: stubDir, kind: 'stay_alive' });

    const { logger } = makeLogger();
    let service: any = null;
    let command: any = null;

    plugin.register({
      id: 'proofwork-worker',
      pluginConfig: { apiBaseUrl: 'http://127.0.0.1:1234', workerScriptPath },
      logger,
      registerService: (s: any) => {
        service = s;
      },
      registerCommand: (c: any) => {
        command = c;
      },
    } as any);

    const ctx = { config: {}, stateDir, workspaceDir, logger };
    const paths = __internal.computeStateRoot({ stateDir, workspaceDir });
    const tokenFile = join(paths.root, 'worker-token.json');

    await service.start(ctx);
    await sleep(150);
    await writeFile(tokenFile, JSON.stringify({ workerId: 'w_1', token: 'tok_1' }) + '\n', { mode: 0o600 });

    const fetchMock = vi.fn(async (url: any, init: any) => {
      const u = String(url);
      if (u.endsWith('/api/worker/me')) {
        return new Response(
          JSON.stringify({
            workerId: 'w_1',
            payout: { chain: null, address: null, verifiedAt: null },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.endsWith('/api/worker/payout-address/message')) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        return new Response(
          JSON.stringify({
            ok: true,
            chain: body.chain ?? 'base',
            address: body.address ?? '0xabc',
            message: `Proofwork payout address verification\nworkerId=w_1\nchain=${body.chain ?? 'base'}\naddress=${body.address ?? '0xabc'}`,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.endsWith('/api/worker/payout-address')) {
        return new Response(
          JSON.stringify({
            ok: true,
            chain: 'base',
            address: '0xabc',
            unblockedPayouts: 2,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ error: { message: 'not found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });

    vi.stubGlobal('fetch', fetchMock as any);

    try {
      const st = await command.handler({ args: 'payout status' });
      expect(String(st.text)).toContain('proofwork payout');
      expect(String(st.text)).toContain('workerId: w_1');

      const msg = await command.handler({ args: 'payout message 0xabc base' });
      expect(String(msg.text)).toContain('Sign this message');
      expect(String(msg.text)).toContain('Proofwork payout address verification');

      const set = await command.handler({ args: 'payout set 0xabc 0xsig base' });
      expect(String(set.text)).toContain('payout address verified');
      expect(String(set.text)).toContain('unblockedPayouts=2');
    } finally {
      vi.unstubAllGlobals();
      await service.stop(ctx);
    }
  });
});
