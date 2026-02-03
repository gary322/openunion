# Origin Verification (Guardrail)

Proofwork requires a buyer/org to **verify ownership/control of an origin** before it can be used in
`allowedOrigins` for bounties. This prevents creating bounties against arbitrary third-party sites.

## Methods

When you `POST /api/origins`, Proofwork returns an `origin.token` (example: `pw_verify_...`). You must
prove control of the origin using the chosen method, then call:

- `POST /api/origins/:id/check`

If the proof is present, the origin moves to `status=verified`.

### 1) http_file (recommended)

Serve a plaintext file containing the token:

- URL: `/.well-known/proofwork-verify.txt`
- Body must include the token string (exact match is best).

Example:

```
pw_verify_abc123...
```

### 2) dns_txt

Publish a TXT record containing the token:

- Name: `_proofwork.<your-hostname>`
- Value must include the token string

Example:

```
_proofwork.example.com TXT "pw_verify_abc123..."
```

### 3) header

Return a header containing the token on a HEAD request to `/`:

- Header: `X-Proofwork-Verify: <token>`

## Security / SSRF posture

- In `NODE_ENV=production`, Proofwork:
  - requires `https://` origins
  - blocks private/loopback/link-local origins during verification (SSRF protection)
- In non-production, private origins are allowed to keep local dev/test deterministic.

Controls:

- `ORIGIN_VERIFIER_ALLOW_PRIVATE=true` (production override; not recommended)
- `ORIGIN_VERIFIER_TIMEOUT_MS` (default 5000)
- `ORIGIN_VERIFIER_MAX_BYTES` (default 8192)

