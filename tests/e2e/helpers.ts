import http from 'http';

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

