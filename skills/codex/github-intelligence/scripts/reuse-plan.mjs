import { getClientEnv, fetchJson } from './_client.mjs';

const idea = process.argv.slice(2).join(' ').trim();
if (!idea) {
  // eslint-disable-next-line no-console
  console.error('usage: reuse-plan.mjs "your idea"');
  process.exit(2);
}

const { apiBaseUrl, buyerToken } = getClientEnv();
const url = `${apiBaseUrl}/api/intel/reuse-plan`;

const res = await fetchJson({
  url,
  method: 'POST',
  token: buyerToken,
  body: { idea, tool: 'codex' },
});

if (!res.ok) {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ok: false, status: res.status, error: res.json?.error ?? res.json ?? null }, null, 2));
  process.exit(1);
}

process.stdout.write(JSON.stringify(res.json, null, 2) + '\n');

