# Supported origins (system apps)

Some built-in apps are designed to operate against **third-party public websites** that a buyer does not control (so the buyer cannot pass Proofwork origin verification).

To keep the worker safety contract intact while enabling these apps, Proofwork supports an **operator-curated supported-origins allowlist**:

- Stored in `app_supported_origins` (seeded + append-only).
- Used only for **system apps** (owned by `org_system`).
- Still enforced per-job by `bounty.allowedOrigins` and strict worker origin checks.

## What “supported origin” means

- Buyers may create/publish bounties that include those origins **without** verifying them.
- Workers still enforce strict origins at runtime.
- This is for a curated subset of third-party sites, not “the whole internet”.

## Marketplace specifics

Marketplace (`marketplace_drops`) is selector-driven:

- If a job targets a **supported** origin, Proofwork will inject `taskDescriptor.site_profile.selectors` from `marketplace_origin_templates` when the buyer did not provide selectors.
- If the buyer provided selectors, they take precedence.
- If the origin is supported but there is no template and the buyer did not provide selectors, bounty creation fails with `missing_marketplace_template_for_supported_origin`.

## Clips specifics

Clips (`clips_highlights`) is ffmpeg-driven:

- For supported origins, Proofwork requires `input_spec.vod_url` to be a **direct `.mp4` URL** (signed URLs are fine as long as the path ends in `.mp4`).
- This avoids authentication, DRM, and HLS playlists in the public worker pool.

## Buyer: request a new supported origin

Buyers can request new origins for system apps:

1. Find the app id:

```bash
curl -fsS https://<PUBLIC_BASE_URL>/api/apps | jq '.apps[] | {id,slug,taskType}'
```

2. Create a request:

```bash
curl -fsS -X POST https://<PUBLIC_BASE_URL>/api/apps/<APP_ID>/origin-requests \
  -H "Authorization: Bearer <BUYER_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"origin":"https://example.org","message":"Please support this site for Marketplace."}'
```

3. Check request status:

```bash
curl -fsS https://<PUBLIC_BASE_URL>/api/apps/<APP_ID>/origin-requests \
  -H "Authorization: Bearer <BUYER_API_KEY>"
```

## Operator: review requests (admin)

List pending:

```bash
curl -fsS https://<PUBLIC_BASE_URL>/api/admin/origin-requests?status=pending \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

Approve/reject:

```bash
curl -fsS -X POST https://<PUBLIC_BASE_URL>/api/admin/origin-requests/<REQUEST_ID>/review \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"action":"approve","notes":"ok"}'
```

After approval, the origin is inserted into `app_supported_origins`.

## Deterministic smoke origins

When `PUBLIC_BASE_URL` is set, Proofwork seeds that origin as supported for Marketplace/Clips so staging/prod can host deterministic test targets:

- `GET /__smoke/marketplace/items` (Marketplace DOM)
- `GET /__smoke/browser-flow/ok` (browser_flow click/type)
- `GET /__smoke/media/sample.mp4` (Clips mp4)
- `GET /__smoke/jobs/board` (Jobs screenshot target)
- `GET /__smoke/remotive/api/remote-jobs` (Remotive API shape)
- `GET /__smoke/github/search/repositories` (GitHub search API shape)
- `GET /__smoke/arxiv/api/query` (arXiv Atom feed shape)
