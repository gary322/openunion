import { describe, it, expect } from 'vitest';
import { __internal } from '../scripts/openclaw_proofwork_connect.mjs';

describe('openclaw_proofwork_connect.mjs', () => {
  it('installs the plugin, sets config, and restarts the gateway', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runCommand = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (args[0] === '--version') {
        return { code: 0, stdout: 'openclaw 2026.2.2-3\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };

    const logs: string[] = [];
    await __internal.runConnect(
      {
        apiBaseUrl: 'https://api.proofwork.example',
        pluginSpec: '@proofwork/proofwork-worker',
        openclawBin: 'openclaw',
        browserProfile: 'proofwork-worker',
        canaryPercent: 10,
        dryRun: false,
      },
      { runCommand, log: (s: string) => logs.push(s) }
    );

    expect(calls.map((c) => [c.cmd, ...c.args].join(' '))).toEqual([
      'openclaw --version',
      'openclaw plugins install @proofwork/proofwork-worker',
      'openclaw config set --json plugins.enabled true',
      'openclaw config set --json plugins.entries.proofwork-worker.enabled true',
      expect.stringContaining('openclaw config set --json plugins.entries.proofwork-worker.config'),
      'openclaw gateway restart --json',
    ]);

    const configCall = calls.find((c) => c.args[0] === 'config' && c.args[1] === 'set' && c.args[3] === 'plugins.entries.proofwork-worker.config');
    expect(configCall).toBeTruthy();
    const cfgJson = String(configCall?.args?.[4] ?? '');
    const cfg = JSON.parse(cfgJson);
    expect(cfg.apiBaseUrl).toBe('https://api.proofwork.example');
    expect(cfg.browserProfile).toBe('proofwork-worker');
    expect(cfg.openclawBin).toBe('openclaw');
    expect(cfg.canaryPercent).toBe(10);

    expect(logs.join('\n')).toContain('Connected Proofwork worker to OpenClaw.');
    expect(logs.join('\n')).toContain('/proofwork status');
    expect(logs.join('\n')).toContain('/proofwork payout message');
  });

  it('supports --dry-run without executing commands', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runCommand = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: '', stderr: '' };
    };

    await __internal.runConnect(
      {
        apiBaseUrl: 'https://api.proofwork.example',
        pluginSpec: '@proofwork/proofwork-worker',
        openclawBin: 'openclaw',
        browserProfile: 'proofwork-worker',
        dryRun: true,
      },
      { runCommand, log: () => {} }
    );

    expect(calls.length).toBe(0);
  });

  it('fails fast on old OpenClaw versions', async () => {
    const runCommand = async (_cmd: string, args: string[]) => {
      if (args[0] === '--version') return { code: 0, stdout: 'openclaw 2025.12.0\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };

    await expect(
      __internal.runConnect(
        {
          apiBaseUrl: 'https://api.proofwork.example',
          pluginSpec: '@proofwork/proofwork-worker',
          openclawBin: 'openclaw',
          browserProfile: 'proofwork-worker',
          dryRun: false,
        },
        { runCommand, log: () => {} }
      )
    ).rejects.toThrow(/openclaw_too_old/);
  });
});

