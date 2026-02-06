import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const pkgDir = path.join(repoRoot, 'integrations', 'openclaw', 'extensions', 'proofwork-worker');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function sh(cmd: string, args: string[], opts: { cwd?: string } = {}) {
  return execFileSync(cmd, args, { cwd: opts.cwd ?? repoRoot, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
}

describe('OpenClaw Proofwork Worker plugin packaging', () => {
  it('packs a self-contained plugin tarball that includes the bundled worker script', async () => {
    // Ensure assets are synced (fail the test if stale).
    sh(process.execPath, ['scripts/sync_assets.mjs', '--check'], { cwd: pkgDir });

    const pkgJson = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const pluginJson = JSON.parse(readFileSync(path.join(pkgDir, 'openclaw.plugin.json'), 'utf8'));
    expect(String(pluginJson?.version ?? '')).toBe(String(pkgJson?.version ?? ''));

    const tgzName = sh('npm', ['pack', '--silent'], { cwd: pkgDir }).trim().split(/\r?\n/).pop() ?? '';
    expect(tgzName.endsWith('.tgz')).toBe(true);
    const tgzPath = path.join(pkgDir, tgzName);

    const entries = sh('tar', ['-tf', tgzPath], { cwd: pkgDir })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    expect(entries).toContain('package/openclaw.plugin.json');
    expect(entries).toContain('package/index.ts');
    expect(entries).toContain('package/assets/proofwork_worker.mjs');
    expect(entries).toContain('package/bin/proofwork-connect.mjs');

    const extractDir = await mkdtemp(path.join(tmpdir(), 'proofwork-plugin-pack-'));
    try {
      sh('tar', ['-xzf', tgzPath, '-C', extractDir], { cwd: pkgDir });

      const connectBin = path.join(extractDir, 'package', 'bin', 'proofwork-connect.mjs');
      const connectHelp = sh(process.execPath, [connectBin, '--help'], { cwd: repoRoot });
      expect(connectHelp).toContain('Usage:');
      expect(connectHelp).toContain('--apiBaseUrl');

      const pluginEntry = path.join(extractDir, 'package', 'index.ts');
      const code = [
        'import { pathToFileURL } from "node:url";',
        '(async () => {',
        `  const mod = await import(pathToFileURL(${JSON.stringify(pluginEntry)}).href);`,
        '  process.stdout.write(String(mod.__internal.resolveWorkerScriptPath()));',
        '})().catch((err) => { console.error(String(err?.message ?? err)); process.exit(1); });',
      ].join('\n');

      const resolved = sh(process.execPath, [tsxCli, '-e', code], { cwd: repoRoot }).trim();
      expect(resolved.replaceAll('\\', '/')).toMatch(/\/assets\/proofwork_worker\.mjs$/);
    } finally {
      await rm(extractDir, { recursive: true, force: true });
      await rm(tgzPath, { force: true });
    }
  });
});
