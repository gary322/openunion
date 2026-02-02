import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { JsonRpcProvider, Wallet, ContractFactory, getAddress } from 'ethers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function requireEnv(name: string) {
  const v = process.env[name];
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
  const rpcUrl = process.env.LOCAL_EVM_RPC_URL ?? 'http://127.0.0.1:8545';
  const privateKey = requireEnv('LOCAL_EVM_PRIVATE_KEY');
  const provider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(privateKey, provider);

  const usdcArtifact = await loadArtifact('contracts/MockUSDC.sol/MockUSDC.json');
  const splitterArtifact = await loadArtifact('contracts/PayoutSplitter.sol/PayoutSplitter.json');

  const usdcFactory = new ContractFactory(usdcArtifact.abi, usdcArtifact.bytecode, wallet);
  const payer = getAddress(await wallet.getAddress());
  let nonce = await provider.getTransactionCount(payer, 'pending');

  const usdc = await usdcFactory.deploy({ nonce });
  await usdc.waitForDeployment();
  nonce++;

  const splitterFactory = new ContractFactory(splitterArtifact.abi, splitterArtifact.bytecode, wallet);
  const splitter = await splitterFactory.deploy({ nonce });
  await splitter.waitForDeployment();
  nonce++;

  // Mint 1,000 USDC (6 decimals) to the payer and approve splitter.
  const mintAmount = 1_000_000_000n; // 1000 * 1e6
  const approveAmount = 10_000_000_000n;
  await (await usdc.mint(payer, mintAmount, { nonce })).wait();
  nonce++;
  await (await usdc.approve(await splitter.getAddress(), approveAmount, { nonce })).wait();

  const out = {
    rpcUrl,
    payerAddress: payer,
    usdc: await usdc.getAddress(),
    payoutSplitter: await splitter.getAddress(),
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

