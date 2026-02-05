import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { __internal } from '../integrations/openclaw/extensions/proofwork-worker/bin/proofwork-connect.mjs';

describe('proofwork-connect (npx bin)', () => {
  it('installs + starts the gateway service when restart reports not-loaded', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runCommand = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (args[0] === '--version') return { code: 0, stdout: 'openclaw 2026.2.2-3\n', stderr: '' };
      if (args[0] === 'gateway' && args[1] === 'restart') {
        return { code: 0, stdout: JSON.stringify({ action: 'restart', ok: true, result: 'not-loaded', service: { loaded: false } }), stderr: '' };
      }
      if (args[0] === 'health') return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
      if (args[0] === 'gateway' && args[1] === 'status') return { code: 0, stdout: JSON.stringify({ service: { loaded: false }, rpc: { ok: false } }), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };

    await __internal.runConnect(
      {
        apiBaseUrl: 'https://api.proofwork.example',
        pluginSpec: '@proofwork/proofwork-worker',
        openclawBin: 'openclaw',
        browserProfile: 'proofwork-worker',
        canaryPercent: 10,
        healthCheck: false,
        doctor: false,
        waitForWorkerMs: 1000,
        dryRun: false,
      },
      { runCommand, log: () => {} }
    );

    const rendered = calls.map((c) => [c.cmd, ...c.args].join(' '));
    expect(rendered).toContain('openclaw gateway install --json');
    expect(rendered).toContain('openclaw gateway start --json');
  });

  it('health-checks by waiting for the worker status file', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'openclaw-state-'));
    const workspaceDir = path.join(stateDir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });

    const hash = __internal.sha256Hex(path.resolve(workspaceDir)).slice(0, 12);
    const statusFile = path.join(stateDir, 'plugins', 'proofwork-worker', hash, 'status.json');
    await mkdir(path.dirname(statusFile), { recursive: true });
    await writeFile(statusFile, JSON.stringify({ workerId: 'wk_test_123', lastPollAt: Date.now() }, null, 2) + '\n');

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runCommand = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (args[0] === '--version') return { code: 0, stdout: 'openclaw 2026.2.2-3\n', stderr: '' };
      if (args[0] === 'gateway' && args[1] === 'status') {
        const payload = {
          service: { loaded: true },
          rpc: { ok: true },
          config: { cli: { path: path.join(stateDir, 'openclaw.json') } },
        };
        return { code: 0, stdout: JSON.stringify(payload), stderr: '' };
      }
      if (args[0] === 'gateway' && args[1] === 'restart') {
        return { code: 0, stdout: JSON.stringify({ action: 'restart', ok: true, result: 'restarted', service: { loaded: true } }), stderr: '' };
      }
      if (args[0] === 'health') return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
      if (args[0] === 'config' && args[1] === 'get' && args[3] === 'agents.defaults.workspace') {
        return { code: 0, stdout: JSON.stringify(workspaceDir), stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };

    const logs: string[] = [];
    try {
      await __internal.runConnect(
        {
          apiBaseUrl: 'https://api.proofwork.example',
          pluginSpec: '@proofwork/proofwork-worker',
          openclawBin: 'openclaw',
          browserProfile: 'proofwork-worker',
          canaryPercent: undefined,
          healthCheck: true,
          doctor: false,
          waitForWorkerMs: 1000,
          dryRun: false,
        },
        { runCommand, log: (s: string) => logs.push(s) }
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }

    expect(logs.join('\n')).toContain('Proofwork worker is running. workerId=wk_test_123');
    expect(calls.map((c) => [c.cmd, ...c.args].join(' '))).toContain('openclaw health --json');
  });
});

