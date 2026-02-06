import { describe, expect, it } from 'vitest';
import { DEFAULT_BASE_RPC_URL, readPayoutPreflightConfig, summarizeCheckOutcome, validatePayoutPreflightConfig } from '../src/ops/payoutPreflight.js';

describe('payout preflight config validation', () => {
  it('passes with pinned Base USDC defaults', () => {
    const cfg = readPayoutPreflightConfig({
      PAYMENTS_PROVIDER: 'crypto_base_usdc',
      BASE_RPC_URL: DEFAULT_BASE_RPC_URL,
      BASE_PAYOUT_SPLITTER_ADDRESS: '0x1111111111111111111111111111111111111111',
      PROOFWORK_FEE_BPS: '100',
      PROOFWORK_FEE_WALLET_BASE: '0xC9862D6326E93b818d7C735Dc8af6eBddD066bDF',
      KMS_PAYOUT_KEY_ID: 'kms-key-id',
    } as NodeJS.ProcessEnv);

    const checks = validatePayoutPreflightConfig(cfg);
    const summary = summarizeCheckOutcome(checks);
    expect(summary.ok).toBe(true);
  });

  it('fails on provider/rpc/fee wallet drift', () => {
    const cfg = readPayoutPreflightConfig({
      PAYMENTS_PROVIDER: 'mock',
      BASE_RPC_URL: 'https://example.invalid',
      BASE_PAYOUT_SPLITTER_ADDRESS: '0x1111111111111111111111111111111111111111',
      PROOFWORK_FEE_BPS: '100',
      PROOFWORK_FEE_WALLET_BASE: '0x1111111111111111111111111111111111111111',
      KMS_PAYOUT_KEY_ID: 'kms-key-id',
    } as NodeJS.ProcessEnv);

    const checks = validatePayoutPreflightConfig(cfg);
    const summary = summarizeCheckOutcome(checks);
    expect(summary.ok).toBe(false);
    expect(summary.failures.some((f) => f.key === 'PAYMENTS_PROVIDER.expected')).toBe(true);
    expect(summary.failures.some((f) => f.key === 'BASE_RPC_URL.expected')).toBe(true);
    expect(summary.failures.some((f) => f.key === 'PROOFWORK_FEE_WALLET_BASE.expected')).toBe(true);
  });
});
