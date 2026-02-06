import { Contract, JsonRpcProvider, formatEther, formatUnits, getAddress } from 'ethers';
import { KmsEvmSigner } from '../../src/payments/crypto/kmsSigner.js';
import { readPayoutPreflightConfig, summarizeCheckOutcome, validatePayoutPreflightConfig, type PreflightCheck } from '../../src/ops/payoutPreflight.js';

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function checkApiHealth(baseUrl: string): Promise<PreflightCheck> {
  const url = `${baseUrl.replace(/\/$/, '')}/health`;
  try {
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) {
      return { key: 'api.health', status: 'fail', message: `GET ${url} -> ${response.status}` };
    }
    return { key: 'api.health', status: 'ok', message: `${url}` };
  } catch (err: any) {
    return { key: 'api.health', status: 'fail', message: `GET ${url} failed: ${String(err?.message ?? err)}` };
  }
}

async function main() {
  const jsonMode = process.argv.includes('--json');
  const skipKms = process.argv.includes('--skip-kms') || String(process.env.SKIP_KMS_CHECK ?? '').trim() === '1';

  const config = readPayoutPreflightConfig(process.env);
  const checks: PreflightCheck[] = [...validatePayoutPreflightConfig(config)];

  const baseUrl = String(argValue('--base-url') ?? process.env.BASE_URL ?? '').trim();
  if (baseUrl) {
    checks.push(await checkApiHealth(baseUrl));
  } else {
    checks.push({
      key: 'api.health',
      status: 'warn',
      message: 'BASE_URL/--base-url not provided, skipping API health check',
    });
  }

  const staticSummary = summarizeCheckOutcome(checks);
  if (!staticSummary.ok) {
    emit(checks, jsonMode);
    process.exitCode = 1;
    return;
  }

  const provider = new JsonRpcProvider(config.baseRpcUrl);
  const chainNetwork = await provider.getNetwork();
  const chainId = Number(chainNetwork.chainId);
  if (chainId === config.expectedBaseChainId) {
    checks.push({ key: 'chain.id', status: 'ok', message: `${chainId}` });
  } else {
    checks.push({
      key: 'chain.id',
      status: 'fail',
      message: `expected ${config.expectedBaseChainId}, got ${chainId}`,
    });
  }

  const splitter = getAddress(config.basePayoutSplitterAddress);
  const code = await provider.getCode(splitter);
  if (code && code !== '0x') {
    checks.push({ key: 'splitter.code', status: 'ok', message: `${splitter}` });
  } else {
    checks.push({ key: 'splitter.code', status: 'fail', message: `no bytecode at ${splitter}` });
  }

  if (!skipKms) {
    const signer = new KmsEvmSigner({ keyId: config.kmsPayoutKeyId });
    const signerAddress = await signer.getAddress();
    checks.push({ key: 'kms.signer', status: 'ok', message: `${signerAddress}` });

    const usdc = new Contract(
      getAddress(config.baseUsdcAddress),
      [
        'function symbol() view returns (string)',
        'function decimals() view returns (uint8)',
        'function balanceOf(address) view returns (uint256)',
        'function allowance(address owner, address spender) view returns (uint256)',
      ],
      provider
    );

    const [symbol, decimals, ethBalance, usdcBalance, allowance] = await Promise.all([
      usdc.symbol(),
      usdc.decimals(),
      provider.getBalance(signerAddress),
      usdc.balanceOf(signerAddress),
      usdc.allowance(signerAddress, splitter),
    ]);

    if (ethBalance >= config.minSignerEthWei) {
      checks.push({
        key: 'signer.eth_balance',
        status: 'ok',
        message: `${formatEther(ethBalance)} ETH (min=${config.minSignerEthWei.toString()} wei)`,
      });
    } else {
      checks.push({
        key: 'signer.eth_balance',
        status: 'fail',
        message: `${formatEther(ethBalance)} ETH is below min ${config.minSignerEthWei.toString()} wei`,
      });
    }

    if (usdcBalance >= config.minSignerUsdcBaseUnits) {
      checks.push({
        key: 'signer.usdc_balance',
        status: 'ok',
        message: `${formatUnits(usdcBalance, decimals)} ${symbol} (min=${config.minSignerUsdcBaseUnits.toString()} units)`,
      });
    } else {
      checks.push({
        key: 'signer.usdc_balance',
        status: 'fail',
        message: `${formatUnits(usdcBalance, decimals)} ${symbol} is below min ${config.minSignerUsdcBaseUnits.toString()} units`,
      });
    }

    if (allowance >= config.minAllowanceBaseUnits) {
      checks.push({
        key: 'signer.usdc_allowance',
        status: 'ok',
        message: `${allowance.toString()} units (min=${config.minAllowanceBaseUnits.toString()})`,
      });
    } else {
      checks.push({
        key: 'signer.usdc_allowance',
        status: 'fail',
        message: `allowance ${allowance.toString()} is below min ${config.minAllowanceBaseUnits.toString()} units`,
      });
    }
  } else {
    checks.push({ key: 'kms.signer', status: 'warn', message: 'skipped (--skip-kms or SKIP_KMS_CHECK=1)' });
  }

  emit(checks, jsonMode);
  const summary = summarizeCheckOutcome(checks);
  process.exitCode = summary.ok ? 0 : 1;
}

function emit(checks: PreflightCheck[], jsonMode: boolean) {
  const summary = summarizeCheckOutcome(checks);
  if (jsonMode) {
    console.log(JSON.stringify({ ok: summary.ok, checks }, null, 2));
    return;
  }

  for (const check of checks) {
    const prefix = check.status === 'ok' ? '[ok]' : check.status === 'warn' ? '[warn]' : '[fail]';
    console.log(`${prefix} ${check.key} :: ${check.message}`);
  }
  console.log(
    `[summary] ok=${summary.ok} checks=${checks.length} failures=${summary.failures.length} warnings=${summary.warnings.length}`
  );
}

main().catch((err) => {
  console.error('[payout-preflight] failed', err);
  process.exitCode = 1;
});
