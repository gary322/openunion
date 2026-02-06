import { getAddress, isAddress } from 'ethers';

export const DEFAULT_BASE_RPC_URL = 'https://mainnet.base.org';
export const DEFAULT_BASE_CHAIN_ID = 8453;
export const DEFAULT_BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const DEFAULT_PROOFWORK_FEE_WALLET_BASE = '0xC9862D6326E93b818d7C735Dc8af6eBddD066bDF';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export type PreflightCheck = {
  key: string;
  status: CheckStatus;
  message: string;
};

export type PayoutPreflightConfig = {
  paymentsProvider: string;
  baseRpcUrl: string;
  basePayoutSplitterAddress: string;
  proofworkFeeBps: number;
  proofworkFeeWalletBase: string;
  kmsPayoutKeyId: string;
  baseUsdcAddress: string;
  expectedPaymentsProvider: string;
  expectedBaseRpcUrl: string;
  expectedProofworkFeeBps: number;
  expectedProofworkFeeWalletBase: string;
  expectedBaseChainId: number;
  minSignerEthWei: bigint;
  minSignerUsdcBaseUnits: bigint;
  minAllowanceBaseUnits: bigint;
};

function readBigInt(value: string | undefined, fallback: bigint): bigint {
  if (!value || !value.trim()) return fallback;
  return BigInt(value.trim());
}

function readInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function normalizeAddress(value: string): string {
  return getAddress(value.trim());
}

export function readPayoutPreflightConfig(env: NodeJS.ProcessEnv): PayoutPreflightConfig {
  return {
    paymentsProvider: String(env.PAYMENTS_PROVIDER ?? '').trim(),
    baseRpcUrl: String(env.BASE_RPC_URL ?? '').trim(),
    basePayoutSplitterAddress: String(env.BASE_PAYOUT_SPLITTER_ADDRESS ?? '').trim(),
    proofworkFeeBps: readInt(env.PROOFWORK_FEE_BPS, 100),
    proofworkFeeWalletBase: String(env.PROOFWORK_FEE_WALLET_BASE ?? '').trim(),
    kmsPayoutKeyId: String(env.KMS_PAYOUT_KEY_ID ?? '').trim(),
    baseUsdcAddress: String(env.BASE_USDC_ADDRESS ?? DEFAULT_BASE_USDC_ADDRESS).trim(),
    expectedPaymentsProvider: String(env.EXPECTED_PAYMENTS_PROVIDER ?? 'crypto_base_usdc').trim(),
    expectedBaseRpcUrl: String(env.EXPECTED_BASE_RPC_URL ?? DEFAULT_BASE_RPC_URL).trim(),
    expectedProofworkFeeBps: readInt(env.EXPECTED_PROOFWORK_FEE_BPS, 100),
    expectedProofworkFeeWalletBase: String(
      env.EXPECTED_PROOFWORK_FEE_WALLET_BASE ?? DEFAULT_PROOFWORK_FEE_WALLET_BASE
    ).trim(),
    expectedBaseChainId: readInt(env.EXPECTED_BASE_CHAIN_ID, DEFAULT_BASE_CHAIN_ID),
    minSignerEthWei: readBigInt(env.MIN_SIGNER_ETH_WEI, 1n),
    minSignerUsdcBaseUnits: readBigInt(env.MIN_SIGNER_USDC_BASE_UNITS, 1n),
    minAllowanceBaseUnits: readBigInt(env.MIN_ALLOWANCE_BASE_UNITS, 1n),
  };
}

export function validatePayoutPreflightConfig(input: PayoutPreflightConfig): PreflightCheck[] {
  const checks: PreflightCheck[] = [];

  const push = (key: string, status: CheckStatus, message: string) => checks.push({ key, status, message });

  if (!input.paymentsProvider) push('PAYMENTS_PROVIDER.present', 'fail', 'PAYMENTS_PROVIDER is missing');
  if (!input.baseRpcUrl) push('BASE_RPC_URL.present', 'fail', 'BASE_RPC_URL is missing');
  if (!input.basePayoutSplitterAddress)
    push('BASE_PAYOUT_SPLITTER_ADDRESS.present', 'fail', 'BASE_PAYOUT_SPLITTER_ADDRESS is missing');
  if (!input.proofworkFeeWalletBase)
    push('PROOFWORK_FEE_WALLET_BASE.present', 'fail', 'PROOFWORK_FEE_WALLET_BASE is missing');
  if (!input.kmsPayoutKeyId) push('KMS_PAYOUT_KEY_ID.present', 'fail', 'KMS_PAYOUT_KEY_ID is missing');

  if (input.paymentsProvider) {
    if (input.paymentsProvider === input.expectedPaymentsProvider) {
      push('PAYMENTS_PROVIDER.expected', 'ok', `${input.paymentsProvider}`);
    } else {
      push(
        'PAYMENTS_PROVIDER.expected',
        'fail',
        `expected ${input.expectedPaymentsProvider}, got ${input.paymentsProvider}`
      );
    }
  }

  if (input.baseRpcUrl) {
    if (input.baseRpcUrl === input.expectedBaseRpcUrl) {
      push('BASE_RPC_URL.expected', 'ok', `${input.baseRpcUrl}`);
    } else {
      push('BASE_RPC_URL.expected', 'fail', `expected ${input.expectedBaseRpcUrl}, got ${input.baseRpcUrl}`);
    }
  }

  if (Number.isFinite(input.proofworkFeeBps)) {
    if (input.proofworkFeeBps === input.expectedProofworkFeeBps) {
      push('PROOFWORK_FEE_BPS.expected', 'ok', `${input.proofworkFeeBps}`);
    } else {
      push(
        'PROOFWORK_FEE_BPS.expected',
        'fail',
        `expected ${input.expectedProofworkFeeBps}, got ${input.proofworkFeeBps}`
      );
    }
  } else {
    push('PROOFWORK_FEE_BPS.expected', 'fail', `invalid PROOFWORK_FEE_BPS value: ${input.proofworkFeeBps}`);
  }

  if (input.proofworkFeeWalletBase) {
    if (!isAddress(input.proofworkFeeWalletBase)) {
      push('PROOFWORK_FEE_WALLET_BASE.address', 'fail', `invalid address: ${input.proofworkFeeWalletBase}`);
    } else {
      const actual = normalizeAddress(input.proofworkFeeWalletBase);
      const expected = normalizeAddress(input.expectedProofworkFeeWalletBase);
      if (actual === expected) {
        push('PROOFWORK_FEE_WALLET_BASE.expected', 'ok', actual);
      } else {
        push('PROOFWORK_FEE_WALLET_BASE.expected', 'fail', `expected ${expected}, got ${actual}`);
      }
    }
  }

  if (input.basePayoutSplitterAddress) {
    if (!isAddress(input.basePayoutSplitterAddress)) {
      push('BASE_PAYOUT_SPLITTER_ADDRESS.address', 'fail', `invalid address: ${input.basePayoutSplitterAddress}`);
    } else {
      push('BASE_PAYOUT_SPLITTER_ADDRESS.address', 'ok', normalizeAddress(input.basePayoutSplitterAddress));
    }
  }

  if (input.baseUsdcAddress) {
    if (!isAddress(input.baseUsdcAddress)) {
      push('BASE_USDC_ADDRESS.address', 'fail', `invalid address: ${input.baseUsdcAddress}`);
    } else {
      push('BASE_USDC_ADDRESS.address', 'ok', normalizeAddress(input.baseUsdcAddress));
    }
  }

  if (input.expectedBaseChainId <= 0) {
    push('EXPECTED_BASE_CHAIN_ID.value', 'fail', `invalid expected chain id: ${input.expectedBaseChainId}`);
  } else {
    push('EXPECTED_BASE_CHAIN_ID.value', 'ok', `${input.expectedBaseChainId}`);
  }

  if (input.minSignerEthWei < 0n) push('MIN_SIGNER_ETH_WEI.value', 'fail', 'must be >= 0');
  if (input.minSignerUsdcBaseUnits < 0n) push('MIN_SIGNER_USDC_BASE_UNITS.value', 'fail', 'must be >= 0');
  if (input.minAllowanceBaseUnits < 0n) push('MIN_ALLOWANCE_BASE_UNITS.value', 'fail', 'must be >= 0');

  return checks;
}

export function summarizeCheckOutcome(checks: PreflightCheck[]) {
  const failures = checks.filter((check) => check.status === 'fail');
  const warnings = checks.filter((check) => check.status === 'warn');
  const oks = checks.filter((check) => check.status === 'ok');
  return {
    ok: failures.length === 0,
    failures,
    warnings,
    oks,
  };
}
