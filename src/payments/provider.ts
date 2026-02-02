export interface ProviderPayoutRequest {
  payoutId: string;
  amountCents: number;
  currency?: string;
  workerId: string;
}

export interface ProviderPayoutResult {
  provider: string;
  providerRef: string;
  status: 'paid' | 'failed';
}

export interface PaymentProvider {
  createPayout(req: ProviderPayoutRequest): Promise<ProviderPayoutResult>;
}

class MockProvider implements PaymentProvider {
  async createPayout(req: ProviderPayoutRequest): Promise<ProviderPayoutResult> {
    // Simulate immediate success.
    return {
      provider: 'mock',
      providerRef: `mock_${req.payoutId}`,
      status: 'paid',
    };
  }
}

class HttpProvider implements PaymentProvider {
  private url: string;
  private authHeader?: string;

  constructor(url: string, authHeader?: string) {
    this.url = url;
    this.authHeader = authHeader;
  }

  async createPayout(req: ProviderPayoutRequest): Promise<ProviderPayoutResult> {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.authHeader ? { Authorization: this.authHeader } : {}),
      },
      body: JSON.stringify(req),
    });
    if (!resp.ok) throw new Error(`payment_provider_failed:${resp.status}`);
    const body = (await resp.json()) as any;
    if (!body?.provider || !body?.providerRef || !['paid', 'failed'].includes(body?.status)) {
      throw new Error('payment_provider_invalid_response');
    }
    return { provider: String(body.provider), providerRef: String(body.providerRef), status: body.status };
  }
}

export function getPaymentProvider(): PaymentProvider {
  const provider = process.env.PAYMENTS_PROVIDER ?? 'mock';
  if (provider === 'mock') return new MockProvider();
  if (provider === 'http') {
    const url = process.env.PAYMENTS_PROVIDER_URL;
    if (!url) throw new Error('PAYMENTS_PROVIDER_URL is required when PAYMENTS_PROVIDER=http');
    return new HttpProvider(url, process.env.PAYMENTS_PROVIDER_AUTH_HEADER);
  }
  throw new Error(`Unsupported PAYMENTS_PROVIDER: ${provider}`);
}

