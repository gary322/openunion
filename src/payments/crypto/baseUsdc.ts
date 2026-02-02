import { id, Transaction } from 'ethers';
import type { EvmSigner } from './evmSigner.js';

export const BASE_CHAIN_ID = 8453;

export function evmChainId() {
  return Number(process.env.EVM_CHAIN_ID ?? BASE_CHAIN_ID);
}

export function computeFeeSplitCents(grossCents: number, feeBps: number): { feeCents: number; netCents: number } {
  if (!Number.isFinite(grossCents) || grossCents < 0) throw new Error('invalid_gross');
  if (!Number.isFinite(feeBps) || feeBps < 0 || feeBps > 10_000) throw new Error('invalid_fee_bps');
  const feeCents = Math.floor((grossCents * feeBps) / 10_000);
  const netCents = grossCents - feeCents;
  return { feeCents, netCents };
}

export function computePayoutSplitCents(
  grossCents: number,
  input: { platformFeeBps: number; proofworkFeeBps: number }
): { platformFeeCents: number; proofworkFeeCents: number; netCents: number } {
  if (!Number.isFinite(grossCents) || grossCents < 0) throw new Error('invalid_gross');
  const platformFeeBps = Number(input.platformFeeBps);
  const proofworkFeeBps = Number(input.proofworkFeeBps);
  if (!Number.isFinite(platformFeeBps) || platformFeeBps < 0 || platformFeeBps > 10_000) throw new Error('invalid_platform_fee_bps');
  if (!Number.isFinite(proofworkFeeBps) || proofworkFeeBps < 0 || proofworkFeeBps > 10_000) throw new Error('invalid_proofwork_fee_bps');
  if (platformFeeBps + proofworkFeeBps > 10_000) throw new Error('fee_bps_sum_exceeds_100pct');

  const platformFeeCents = Math.floor((grossCents * platformFeeBps) / 10_000);
  const proofworkFeeCents = Math.floor((grossCents * proofworkFeeBps) / 10_000);
  const total = platformFeeCents + proofworkFeeCents;
  if (total > grossCents) throw new Error('fee_exceeds_gross');
  return { platformFeeCents, proofworkFeeCents, netCents: grossCents - total };
}

export function centsToUsdcBaseUnits(cents: number): bigint {
  // 1 cent = $0.01. USDC has 6 decimals, so: cents * 10^(6-2) = cents * 10,000
  if (!Number.isFinite(cents) || cents < 0) throw new Error('invalid_cents');
  return BigInt(Math.trunc(cents)) * 10_000n;
}

export function rpcUrl() {
  const url = process.env.BASE_RPC_URL;
  if (!url) throw new Error('BASE_RPC_URL not configured');
  return url;
}

export function baseUsdcAddress() {
  return process.env.BASE_USDC_ADDRESS ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
}

export function payoutSplitterAddress() {
  const addr = process.env.BASE_PAYOUT_SPLITTER_ADDRESS;
  if (!addr) throw new Error('BASE_PAYOUT_SPLITTER_ADDRESS not configured');
  return addr;
}

export function proofworkFeeWallet() {
  // Prefer the explicit Proofwork env var; keep the legacy PLATFORM_* envs as a fallback.
  const addr = process.env.PROOFWORK_FEE_WALLET_BASE ?? process.env.PLATFORM_FEE_WALLET_BASE;
  if (!addr) throw new Error('PROOFWORK_FEE_WALLET_BASE not configured');
  return addr;
}

export function proofworkFeeBps() {
  // Proofwork takes a fixed fee (default 1%) in addition to per-org platform cuts.
  const bps = Number(process.env.PROOFWORK_FEE_BPS ?? process.env.PLATFORM_FEE_BPS ?? 100);
  if (!Number.isFinite(bps) || bps < 0 || bps > 10_000) throw new Error('invalid_proofwork_fee_bps');
  const max = Number(process.env.MAX_PROOFWORK_FEE_BPS ?? process.env.MAX_PLATFORM_FEE_BPS ?? 10_000);
  if (!Number.isFinite(max) || max < 0 || max > 10_000) throw new Error('invalid_max_proofwork_fee_bps');
  if (bps > max) throw new Error(`proofwork_fee_bps_exceeds_max:${bps}:${max}`);
  return bps;
}

// Deprecated aliases: kept for backwards compatibility with older scripts/tests.
export function platformFeeWallet() {
  return proofworkFeeWallet();
}

export function platformFeeBps() {
  return proofworkFeeBps();
}

export async function rpcCall<T = any>(method: string, params: any[]): Promise<T> {
  const resp = await fetch(rpcUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = (await resp.json()) as any;
  if (json?.error) throw new Error(`rpc_error:${json.error.code}:${json.error.message}`);
  return json.result as T;
}

export async function getPendingNonce(address: string): Promise<bigint> {
  const hex = await rpcCall<string>('eth_getTransactionCount', [address, 'pending']);
  return BigInt(hex);
}

export async function getLatestBlockNumber(): Promise<bigint> {
  const hex = await rpcCall<string>('eth_blockNumber', []);
  return BigInt(hex);
}

export async function getTransactionReceipt(txHash: string): Promise<any | null> {
  return await rpcCall<any | null>('eth_getTransactionReceipt', [txHash]);
}

// Minimal ABI encoding for: payout(address token,address worker,address platform,uint256 net,uint256 fee)
// selector = keccak256("payout(address,address,address,uint256,uint256)")[:4]
export function encodePayoutSplitterCall(input: {
  token: string;
  worker: string;
  platform: string;
  net: bigint;
  fee: bigint;
}): string {
  const selector = id('payout(address,address,address,uint256,uint256)').slice(0, 10);
  const pad32 = (hexNo0x: string) => hexNo0x.padStart(64, '0');
  const addr = (a: string) => pad32(a.toLowerCase().replace(/^0x/, ''));
  const u256 = (v: bigint) => pad32(v.toString(16));

  return (
    selector +
    addr(input.token) +
    addr(input.worker) +
    addr(input.platform) +
    u256(input.net) +
    u256(input.fee)
  );
}

// Minimal ABI encoding for: payoutV2(address token,address worker,address platform,address proofwork,uint256 net,uint256 platformFee,uint256 proofworkFee)
// selector = keccak256("payoutV2(address,address,address,address,uint256,uint256,uint256)")[:4]
export function encodePayoutSplitterCallV2(input: {
  token: string;
  worker: string;
  platform: string;
  proofwork: string;
  net: bigint;
  platformFee: bigint;
  proofworkFee: bigint;
}): string {
  const selector = id('payoutV2(address,address,address,address,uint256,uint256,uint256)').slice(0, 10);
  const pad32 = (hexNo0x: string) => hexNo0x.padStart(64, '0');
  const addr = (a: string) => pad32(a.toLowerCase().replace(/^0x/, ''));
  const u256 = (v: bigint) => pad32(v.toString(16));

  return (
    selector +
    addr(input.token) +
    addr(input.worker) +
    addr(input.platform) +
    addr(input.proofwork) +
    u256(input.net) +
    u256(input.platformFee) +
    u256(input.proofworkFee)
  );
}

export async function signAndBroadcastSplitterTx(input: {
  signer: EvmSigner;
  chainId?: number;
  nonce: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  data: string;
}): Promise<{ from: string; txHash: string; signedTx: string }> {
  const chainId = input.chainId ?? evmChainId();
  const from = await input.signer.getAddress();

  const tx = Transaction.from({
    type: 2,
    chainId,
    to: payoutSplitterAddress(),
    nonce: Number(input.nonce),
    gasLimit: input.gasLimit,
    maxFeePerGas: input.maxFeePerGas,
    maxPriorityFeePerGas: input.maxPriorityFeePerGas,
    value: 0n,
    data: input.data,
  });

  const sig = await input.signer.signDigest(tx.unsignedHash);
  tx.signature = sig;
  const signedTx = tx.serialized;

  const txHash = await rpcCall<string>('eth_sendRawTransaction', [signedTx]);
  return { from, txHash, signedTx };
}
