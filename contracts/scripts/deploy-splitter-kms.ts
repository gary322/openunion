import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getCreateAddress } from 'ethers';
import { KmsEvmSigner } from '../../src/payments/crypto/kmsSigner.js';
import { getPendingNonce, rpcCall, signAndBroadcastTx } from '../../src/payments/crypto/baseUsdc.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function requireEnv(name: string) {
  const v = String(process.env[name] ?? '').trim();
  if (!v) throw new Error(`${name} not set`);
  return v;
}

async function loadArtifact(relativePathFromContractsDir: string) {
  // Hardhat artifacts live under contracts/artifacts/...
  const p = path.resolve(__dirname, '..', 'artifacts', relativePathFromContractsDir);
  const txt = await readFile(p, 'utf8');
  const json = JSON.parse(txt) as any;
  if (!json?.bytecode) throw new Error(`bad_artifact:${relativePathFromContractsDir}`);
  return json;
}

async function main() {
  // Default to the public Base mainnet RPC.
  const rpcUrl = String(process.env.RPC_URL ?? process.env.BASE_RPC_URL ?? 'https://mainnet.base.org').trim();
  process.env.BASE_RPC_URL = rpcUrl;

  const kmsKeyId = String(process.env.KMS_PAYOUT_KEY_ID ?? process.env.KMS_KEY_ID ?? '').trim();
  if (!kmsKeyId) throw new Error('KMS_PAYOUT_KEY_ID (or KMS_KEY_ID) not set');

  const signer = new KmsEvmSigner({ keyId: kmsKeyId });
  const from = await signer.getAddress();

  const chainIdHex = await rpcCall<string>('eth_chainId', []);
  const chainId = Number(BigInt(chainIdHex));

  const balHex = await rpcCall<string>('eth_getBalance', [from, 'latest']);
  if (balHex === '0x0') {
    console.warn(`[deploy] WARNING: from=${from} has 0 ETH on chainId=${chainId}. Fund it before deploying.`);
  }

  const artifact = await loadArtifact('contracts/PayoutSplitter.sol/PayoutSplitter.json');
  const bytecode = String(artifact.bytecode ?? '').trim();
  if (!bytecode.startsWith('0x')) throw new Error('splitter_bytecode_missing');

  const nonce = await getPendingNonce(from);
  const predicted = getCreateAddress({ from, nonce: Number(nonce) });

  const gasLimit = BigInt(process.env.DEPLOY_GAS_LIMIT ?? '800000');
  const maxPriorityFeePerGas = process.env.BASE_MAX_PRIORITY_FEE_PER_GAS_WEI
    ? BigInt(process.env.BASE_MAX_PRIORITY_FEE_PER_GAS_WEI)
    : BigInt(await rpcCall('eth_maxPriorityFeePerGas', []));
  const gasPrice = BigInt(await rpcCall('eth_gasPrice', []));
  const maxFeePerGas = process.env.BASE_MAX_FEE_PER_GAS_WEI ? BigInt(process.env.BASE_MAX_FEE_PER_GAS_WEI) : gasPrice * 2n;

  const { txHash } = await signAndBroadcastTx({
    signer,
    chainId,
    nonce,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    to: null,
    data: bytecode,
  });

  const out = { rpcUrl, chainId, deployer: from, nonce: nonce.toString(), payoutSplitter: predicted, txHash };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
