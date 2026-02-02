import { describe, it, expect } from 'vitest';
import { centsToUsdcBaseUnits, computeFeeSplitCents, computePayoutSplitCents, proofworkFeeBps } from '../src/payments/crypto/baseUsdc.js';

describe('Platform fee split', () => {
  it('computes 10% fee as floor(gross*bps/10000) and net=gross-fee', () => {
    const { feeCents, netCents } = computeFeeSplitCents(1200, 1000);
    expect(feeCents).toBe(120);
    expect(netCents).toBe(1080);
    expect(feeCents + netCents).toBe(1200);
  });

  it('rounds down (floor) for fractional cents', () => {
    const { feeCents, netCents } = computeFeeSplitCents(1234, 1000);
    expect(feeCents).toBe(123);
    expect(netCents).toBe(1111);
    expect(feeCents + netCents).toBe(1234);
  });

  it('computes combined platform + proofwork fee splits', () => {
    const { platformFeeCents, proofworkFeeCents, netCents } = computePayoutSplitCents(1200, {
      platformFeeBps: 1000, // 10%
      proofworkFeeBps: 100, // 1%
    });
    expect(platformFeeCents).toBe(120);
    expect(proofworkFeeCents).toBe(12);
    expect(netCents).toBe(1068);
    expect(platformFeeCents + proofworkFeeCents + netCents).toBe(1200);
  });

  it('converts cents to USDC base units (6 decimals)', () => {
    // $1.20 => 1_200_000 base units
    expect(centsToUsdcBaseUnits(120)).toBe(1_200_000n);
  });

  it('enforces MAX_PROOFWORK_FEE_BPS cap for misconfiguration safety', () => {
    process.env.PROOFWORK_FEE_BPS = '1000';
    process.env.MAX_PROOFWORK_FEE_BPS = '500';
    try {
      expect(() => proofworkFeeBps()).toThrow(/proofwork_fee_bps_exceeds_max/);
    } finally {
      delete process.env.PROOFWORK_FEE_BPS;
      delete process.env.MAX_PROOFWORK_FEE_BPS;
    }
  });
});
