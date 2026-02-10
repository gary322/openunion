import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rpcCall } from '../src/payments/crypto/baseUsdc.js';

describe('Base RPC retry/fallback', () => {
  const realFetch = globalThis.fetch;
  const realEnv = process.env;

  beforeEach(() => {
    process.env = { ...realEnv };
    process.env.BASE_RPC_TIMEOUT_MS = '1000';
    process.env.BASE_RPC_MAX_RETRIES = '2';
    process.env.BASE_RPC_RETRY_BASE_MS = '0';
    process.env.BASE_RPC_RETRY_MAX_MS = '0';
    process.env.BASE_RPC_RETRY_JITTER_MS = '0';
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    process.env = realEnv;
  });

  it('retries on JSON-RPC rate limit errors and then succeeds', async () => {
    process.env.BASE_RPC_URL = 'https://rpc.example';
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32016, message: 'over rate limit' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    const out = await rpcCall<string>('eth_chainId', []);
    expect(out).toBe('0x1');
    expect(calls).toBe(2);
  });

  it('falls back to the next RPC URL on HTTP 429', async () => {
    process.env.BASE_RPC_URL = '';
    process.env.BASE_RPC_URLS = 'https://rpc1.example,https://rpc2.example';

    const calls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('rpc1.example')) {
        return new Response('rate limited', { status: 429 });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    const out = await rpcCall<string>('eth_chainId', []);
    expect(out).toBe('0x2');
    expect(calls.some((c) => c.includes('rpc1.example'))).toBe(true);
    expect(calls.some((c) => c.includes('rpc2.example'))).toBe(true);
  });

  it('does not retry non-retryable RPC errors', async () => {
    process.env.BASE_RPC_URL = 'https://rpc.example';
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    await expect(rpcCall('eth_chainId', [])).rejects.toThrow(/rpc_error:-32601/i);
    expect(calls).toBe(1);
  });
});

