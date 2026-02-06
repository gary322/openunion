import http from 'http';
import type { Page } from '@playwright/test';

export type HttpFileOriginServer = {
  origin: string;
  setVerifyToken: (token: string) => void;
  close: () => Promise<void>;
};

// Stand up a deterministic origin that can be verified via the `http_file` method:
// it serves `/.well-known/proofwork-verify.txt` with a token that the test sets after
// POST /api/origins returns it.
export async function startHttpFileOriginServer(): Promise<HttpFileOriginServer> {
  let verifyToken = '';
  const server = http.createServer((req, res) => {
    if (req.url === '/.well-known/proofwork-verify.txt') {
      if (!verifyToken) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('missing');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(verifyToken);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body><h1>OK</h1></body></html>');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port as number;

  return {
    origin: `http://127.0.0.1:${port}`,
    setVerifyToken: (t: string) => {
      verifyToken = String(t ?? '');
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Fill any required fields on the dynamic app page "friendly form" without hardcoding per-app
// keys. This keeps E2E resilient as app ui_schema evolves.
export async function fillRequiredAppForm(page: Page, opts: { rootSelector?: string } = {}) {
  const root = opts.rootSelector || '#form';
  const entries = await page.locator(`${root} [required]`).evaluateAll((els) =>
    els.map((e) => {
      const tag = e.tagName.toLowerCase();
      const anyEl = e as any;
      return {
        id: String((e as HTMLElement).id || ''),
        tag,
        type: tag === 'input' ? String(anyEl.type || 'text') : '',
        value: tag === 'input' || tag === 'textarea' || tag === 'select' ? String(anyEl.value || '') : '',
        min: tag === 'input' ? String(anyEl.min || '') : '',
        optionsCount: tag === 'select' ? (anyEl.options?.length ?? 0) : 0,
      };
    })
  );

  for (const e of entries) {
    if (!e.id) continue;
    const sel = `#${e.id}`;
    const cur = String(e.value || '').trim();
    if (cur) continue;

    if (e.tag === 'select') {
      if (e.optionsCount > 1) await page.selectOption(sel, { index: 1 });
      continue;
    }
    if (e.tag === 'textarea') {
      await page.fill(sel, 'Example input');
      continue;
    }
    if (e.tag === 'input') {
      if (e.type === 'url') {
        await page.fill(sel, 'https://example.com');
        continue;
      }
      if (e.type === 'date') {
        await page.fill(sel, '2026-02-01');
        continue;
      }
      if (e.type === 'number') {
        const min = Number(e.min);
        const v = Number.isFinite(min) ? Math.max(1, Math.floor(min)) : 1;
        await page.fill(sel, String(v));
        continue;
      }
      await page.fill(sel, 'example');
    }
  }
}
