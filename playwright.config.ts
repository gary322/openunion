import { defineConfig } from '@playwright/test';

const e2ePort = process.env.E2E_PORT ?? '3111';
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${e2ePort}`;
const readyURL = process.env.E2E_READY_URL ?? `${baseURL}/health`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  retries: 0,
  workers: process.env.CI ? 1 : 1,
  webServer: {
    command: 'npm run dev',
    url: readyURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    // Keep E2E deterministic and self-contained: local storage + in-process basic scanning.
    env: {
      ...(process.env as any),
      PORT: e2ePort,
      PUBLIC_BASE_URL: baseURL,
      API_BASE_URL: baseURL,
      STORAGE_BACKEND: 'local',
      SCANNER_ENGINE: 'basic',
    },
    wait: { stdout: /Proofwork API running on :(?<e2e_port>\\d+)/ },
  },
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
});
