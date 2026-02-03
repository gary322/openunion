// Approve the PayoutSplitter contract to spend USDC from the payout signer (treasury).
//
// This is required for on-chain payouts because the splitter uses transferFrom(msg.sender,...).
//
// Usage (Base mainnet):
//   BASE_PAYOUT_SPLITTER_ADDRESS=0x... KMS_PAYOUT_KEY_ID=... node --loader tsx scripts/crypto/approve_base_usdc.ts
//
// Or with a local private key signer:
//   BASE_PAYOUT_SPLITTER_ADDRESS=0x... PAYER_PRIVATE_KEY=0x... node --loader tsx scripts/crypto/approve_base_usdc.ts
//
// Notes:
// - This script prints only non-sensitive values (addresses + tx hash).
// - The signer must have ETH on Base for gas.

import { KmsEvmSigner } from '../../src/payments/crypto/kmsSigner.js';
import { PrivateKeyEvmSigner } from '../../src/payments/crypto/privateKeySigner.js';
import {
  baseUsdcAddress,
  evmChainId,
  getPendingNonce,
  rpcCall,
  signAndBroadcastTx,
  encodeErc20ApproveCall,
} from '../../src/payments/crypto/baseUsdc.js';

function requireEnv(name: string) {
  const v = String(process.env[name] ?? '').trim();
  if (!v) throw new Error(`${name} not set`);
  return v;
}

async function main() {
  // Default to the public Base mainnet RPC.
  const rpcUrl = String(process.env.BASE_RPC_URL ?? 'https://mainnet.base.org').trim();
  process.env.BASE_RPC_URL = rpcUrl;

  const splitter = String(process.env.BASE_PAYOUT_SPLITTER_ADDRESS ?? process.env.SPLITTER_ADDRESS ?? '').trim();
  if (!splitter) throw new Error('BASE_PAYOUT_SPLITTER_ADDRESS not set');

  const token = baseUsdcAddress();
  const chainId = evmChainId();

  const kmsKeyId = String(process.env.KMS_PAYOUT_KEY_ID ?? '').trim();
  const payerPk = String(process.env.PAYER_PRIVATE_KEY ?? process.env.LOCAL_EVM_PRIVATE_KEY ?? '').trim();
  if (!kmsKeyId && !payerPk) throw new Error('Set KMS_PAYOUT_KEY_ID or PAYER_PRIVATE_KEY');

  const signer = kmsKeyId ? new KmsEvmSigner({ keyId: kmsKeyId }) : new PrivateKeyEvmSigner(payerPk.startsWith('0x') ? payerPk : `0x${payerPk}`);
  const from = await signer.getAddress();

  // Ensure the signer has ETH for gas (best-effort check).
  try {
    const balHex = await rpcCall<string>('eth_getBalance', [from, 'latest']);
    if (balHex === '0x0') {
      console.warn(`[approve] WARNING: from=${from} has 0 ETH on chainId=${chainId}. Fund it before sending this tx.`);
    }
  } catch {
    // ignore
  }

  const max = (1n << 256n) - 1n;
  const amount = process.env.APPROVE_AMOUNT_BASE_UNITS ? BigInt(process.env.APPROVE_AMOUNT_BASE_UNITS) : max;
  const data = encodeErc20ApproveCall({ spender: splitter, amount });

  const gasLimit = BigInt(process.env.BASE_GAS_LIMIT ?? '120000');
  const maxPriorityFeePerGas = process.env.BASE_MAX_PRIORITY_FEE_PER_GAS_WEI
    ? BigInt(process.env.BASE_MAX_PRIORITY_FEE_PER_GAS_WEI)
    : BigInt(await rpcCall('eth_maxPriorityFeePerGas', []));
  const gasPrice = BigInt(await rpcCall('eth_gasPrice', []));
  const maxFeePerGas = process.env.BASE_MAX_FEE_PER_GAS_WEI ? BigInt(process.env.BASE_MAX_FEE_PER_GAS_WEI) : gasPrice * 2n;

  const nonce = await getPendingNonce(from);
  const { txHash } = await signAndBroadcastTx({ signer, chainId, nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas, to: token, data });

  const out = { rpcUrl, chainId, from, token, spender: splitter, amount: amount.toString(), txHash };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

