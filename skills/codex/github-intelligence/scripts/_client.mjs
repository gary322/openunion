function requiredEnv(name) {
  const v = String(process.env[name] ?? '').trim();
  if (!v) throw new Error(`missing_env:${name}`);
  return v;
}

export function getClientEnv() {
  const apiBaseUrl = requiredEnv('PROOFWORK_API_BASE_URL').replace(/\/$/, '');
  const buyerToken = requiredEnv('PROOFWORK_BUYER_TOKEN');
  return { apiBaseUrl, buyerToken };
}

export async function fetchJson(input) {
  const { url, method, token, body } = input;
  const ac = new AbortController();
  const timeoutMs = Number.isFinite(Number(input.timeoutMs)) ? Math.max(1000, Math.min(60_000, Math.floor(Number(input.timeoutMs)))) : 25_000;
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  timer.unref?.();
  try {
    const resp = await fetch(url, {
      method: method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const text = await resp.text();
    const json = text ? JSON.parse(text) : null;
    return { ok: resp.ok, status: resp.status, json };
  } finally {
    clearTimeout(timer);
  }
}

