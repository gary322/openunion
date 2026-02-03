import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { ContractFactory, JsonRpcProvider, Wallet, getAddress } from 'ethers';

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
  if (!json?.abi || !json?.bytecode) throw new Error(`bad_artifact:${relativePathFromContractsDir}`);
  return json;
}

async function main() {
  // Default to Base mainnet public RPC, but allow overriding for forks/localnet.
  const rpcUrl = String(process.env.RPC_URL ?? process.env.BASE_RPC_URL ?? 'https://mainnet.base.org').trim();

  // Deployer key should be a funded EOA for the target network (ETH for gas).
  // This key is NOT stored anywhere; we only read from env at runtime.
  const privateKeyRaw = requireEnv('DEPLOYER_PRIVATE_KEY');
  const privateKey = privateKeyRaw.startsWith('0x') ? privateKeyRaw : `0x${privateKeyRaw}`;

  const provider = new JsonRpcProvider(rpcUrl);
  const net = await provider.getNetwork();

  const wallet = new Wallet(privateKey, provider);
  const deployer = getAddress(await wallet.getAddress());

  const splitterArtifact = await loadArtifact('contracts/PayoutSplitter.sol/PayoutSplitter.json');
  const splitterFactory = new ContractFactory(splitterArtifact.abi, splitterArtifact.bytecode, wallet);

  const splitter = await splitterFactory.deploy();
  const deployTx = splitter.deploymentTransaction();
  await splitter.waitForDeployment();

  const out = {
    rpcUrl,
    chainId: Number(net.chainId),
    deployer,
    payoutSplitter: await splitter.getAddress(),
    txHash: deployTx?.hash ?? null,
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

