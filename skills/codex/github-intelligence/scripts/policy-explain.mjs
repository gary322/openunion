import { getClientEnv, fetchJson } from './_client.mjs';

const refId = String(process.argv[2] ?? '').trim();
if (!refId) {
  // eslint-disable-next-line no-console
  console.error('usage: policy-explain.mjs <queryId|planId>');
  process.exit(2);
}

const { apiBaseUrl, buyerToken } = getClientEnv();
const url = `${apiBaseUrl}/api/intel/provenance/${encodeURIComponent(refId)}`;

const res = await fetchJson({
  url,
  method: 'GET',
  token: buyerToken,
});

if (!res.ok) {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ok: false, status: res.status, error: res.json?.error ?? res.json ?? null }, null, 2));
  process.exit(1);
}

process.stdout.write(JSON.stringify(res.json, null, 2) + '\n');

