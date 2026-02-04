// Load .env only in non-test environments (using dynamic import for ESM)
const _loadEnv = (process.env.NODE_ENV !== 'test' && !process.env.VITEST) 
  ? import('dotenv/config').catch(() => {}) 
  : Promise.resolve();
await _loadEnv;
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { sql } from 'kysely';
import { ZodTypeProvider, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { getAddress, verifyMessage } from 'ethers';
import {
  addPayout,
  addSubmission,
  addVerification,
  buildJobSpec,
  createBounty,
  createWorker,
  findClaimableJob,
  findVerificationBySubmission,
  getActiveJobForWorker,
  getBounty,
  getJob,
  getPayout,
  getSubmission,
  getVerification,
  getWorkerByToken,
  isAcceptedDuplicate,
  findSubmissionByIdempotency,
  leaseJob,
  releaseJobLease,
  listBountiesByOrg,
  markPayoutStatus,
  updateJob,
  updateSubmission,
  updateVerification,
  publishBounty,
  listJobsByBounty,
  rateLimitWorker,
  reapExpiredLeases,
  recordReputation,
  registerAcceptedDedupe,
  seedBuiltInApps,
  seedDemoData,
  setBountyStatus,
  verifierBacklog,
  verifierBacklogOldestAgeSec,
  outboxOldestPendingAgeSec,
  artifactScanBacklogOldestAgeSec,
  enqueueOutbox,
  banWorker,
  createOrgApp,
  getAppSummary,
  getAppByTaskType,
  getOrgPlatformFeeSettings,
  setOrgPlatformFeeSettings,
  getOrgCorsAllowOrigins,
  setOrgCorsAllowOrigins,
  getOrgQuotaSettings,
  setOrgQuotaSettings,
  listAllCorsAllowOrigins,
  listAppsByOrg,
  listAllAppsAdmin,
  listPublicApps,
  getPublicAppBySlug,
  adminSetAppStatus,
  updateOrgApp,
  listPayoutsByOrg,
  listPayoutsByWorker,
  listPayoutsAdmin,
  getOrgEarningsSummary,
  listDisputesByOrg,
  listDisputesAdmin,
  createDispute,
  cancelDispute,
  resolveDisputeAdmin,
  listAlarmNotificationsAdmin,
  listBlockedDomainsAdmin,
  upsertBlockedDomainAdmin,
  deleteBlockedDomainAdmin,
  resolveIdAdmin,
  resolveIdOrg,
  resolveIdWorker,
} from './store.js';
import { db } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import {
  seedBuyer,
  verifyPassword,
  createOrgApiKey,
  getApiKey,
  addOrigin,
  listOrigins,
  checkOrigin,
  revokeOrigin,
  originAllowed,
  registerOrg,
} from './buyer.js';
import {
  registerWorkerSchema,
  releaseJobLeaseSchema,
  presignRequestSchema,
  verifierPresignRequestSchema,
  uploadCompleteSchema,
  submitJobSchema,
  workerPayoutAddressSchema,
  workerPayoutAddressMessageSchema,
  verifierClaimSchema,
  verifierVerdictSchema,
  taskDescriptorSchema,
  orgPlatformFeeSchema,
  orgCorsAllowlistSchema,
  orgQuotasSchema,
  orgRegisterSchema,
  appCreateSchema,
  appUpdateSchema,
  disputeCreateSchema,
  disputeResolveSchema,
  adminAppStatusSchema,
  adminPayoutMarkSchema,
  blockedDomainCreateSchema,
  adminArtifactQuarantineSchema,
} from './schemas.js';
import { Envelope, Submission, Verification, Worker } from './types.js';
import { nanoid } from 'nanoid';
import { sha256, isLeaseExpired } from './utils.js';
import { rateLimit } from './ratelimit.js';
import { assertUrlNotBlocked } from './security/blockedDomains.js';
import {
  attachSubmissionArtifacts,
  getArtifactAccessInfo,
  localPathForStorageKey,
  markSubmissionArtifactsAccepted,
  presignArtifactDownloadUrl,
  presignUploads,
  presignVerifierUploads,
  putLocalUpload,
  putVerifierLocalUpload,
  quarantineArtifactObjectAdmin,
  deleteArtifactObject,
} from './storage.js';
import { writeAuditEvent } from './audit.js';
import { hmacSha256Hex } from './auth/tokens.js';
import { inc, renderPrometheusMetrics } from './metrics.js';
import { createReadStream } from 'fs';
import { readFile } from 'fs/promises';
import {
  requireStripeWebhookSecret,
  stripeCreateCheckoutSession,
  stripeCreateCustomer,
  verifyStripeWebhookSignature,
} from './payments/stripe.js';
import { csrfToken, getSession, verifySessionCookie } from './auth/sessions.js';

const LEASE_TTL_MS = 20 * 60 * 1000;
const VERIFIER_TOKEN = process.env.VERIFIER_TOKEN || 'pw_vf_internal';
const VERIFIER_TOKEN_HASH = process.env.VERIFIER_TOKEN_HASH;
const VERIFIER_TOKEN_PEPPER = process.env.VERIFIER_TOKEN_PEPPER ?? process.env.WORKER_TOKEN_PEPPER ?? 'dev_pepper_change_me';
const MAX_VERIFIER_BACKLOG = Number(process.env.MAX_VERIFIER_BACKLOG ?? 500);
const MAX_VERIFICATION_ATTEMPTS = Number(process.env.MAX_VERIFICATION_ATTEMPTS ?? 3);
const TASK_DESCRIPTOR_MAX_BYTES = Number(process.env.TASK_DESCRIPTOR_MAX_BYTES ?? 16000);
const APP_UI_SCHEMA_MAX_BYTES = Number(process.env.APP_UI_SCHEMA_MAX_BYTES ?? 32000);
function isUniversalWorkerPaused() {
  return String(process.env.UNIVERSAL_WORKER_PAUSE ?? '').toLowerCase() === 'true';
}

function shouldSeedDemoData() {
  // In production, do not seed demo users/bounties by default.
  // Set ENABLE_DEMO_SEED=true only in dedicated demo environments.
  const v = String(process.env.ENABLE_DEMO_SEED ?? '').trim().toLowerCase();
  if (v) return ['true', '1', 'yes'].includes(v);
  return process.env.NODE_ENV !== 'production';
}

function isTaskDescriptorEnabled() {
  const v = String(process.env.ENABLE_TASK_DESCRIPTOR ?? 'true').toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no';
}

function maxVerifierBacklogAgeSec() {
  return Number(process.env.MAX_VERIFIER_BACKLOG_AGE_SEC ?? 0);
}

function maxOutboxPendingAgeSec() {
  return Number(process.env.MAX_OUTBOX_PENDING_AGE_SEC ?? 0);
}

function maxArtifactScanBacklogAgeSec() {
  return Number(process.env.MAX_ARTIFACT_SCAN_BACKLOG_AGE_SEC ?? 0);
}

function publicBaseUrlForRequest(request: any): string {
  const env = String(process.env.PUBLIC_BASE_URL ?? '').trim();
  if (env) return env.replace(/\/$/, '');

  const proto = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || 'http';
  const authority = String((request.headers as any)?.[':authority'] ?? '').split(',')[0].trim();
  const host =
    String(request.headers['x-forwarded-host'] ?? '').split(',')[0].trim() ||
    String(request.headers.host ?? '').trim() ||
    authority;
  if (host) return `${proto}://${host}`.replace(/\/$/, '');

  // Fallback for test harnesses that don't set Host (e.g., injection/supertest paths).
  const localPort = request.raw?.socket?.localPort as number | undefined;
  const localAddrRaw = String(request.raw?.socket?.localAddress ?? '').trim();
  const localAddr =
    localAddrRaw === '::1' || localAddrRaw === '::' || localAddrRaw.startsWith('::ffff:')
      ? localAddrRaw.replace(/^::ffff:/, '') || '127.0.0.1'
      : localAddrRaw;
  if (localAddr && localPort) return `${proto}://${localAddr}:${localPort}`.replace(/\/$/, '');

  return 'http://localhost:3000';
}

function blockedContentTypes(): string[] {
  return (process.env.BLOCKED_UPLOAD_CONTENT_TYPES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
const TASK_DESCRIPTOR_MAX_DEPTH = Number(process.env.TASK_DESCRIPTOR_MAX_DEPTH ?? 6);

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'pw_adm_internal';
const ADMIN_TOKEN_HASH = process.env.ADMIN_TOKEN_HASH;
const ADMIN_TOKEN_PEPPER = process.env.ADMIN_TOKEN_PEPPER ?? process.env.WORKER_TOKEN_PEPPER ?? 'dev_pepper_change_me';

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const h = header ?? '';
  for (const part of h.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join('=') ?? '');
  }
  return out;
}

function hasSensitiveKeys(obj: any, depth = 0, maxDepth = TASK_DESCRIPTOR_MAX_DEPTH): boolean {
  if (depth > maxDepth) return true;
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const key = k.toLowerCase();
      if (key.includes('token') || key.includes('secret') || key.includes('password')) return true;
      if (hasSensitiveKeys(v as any, depth + 1, maxDepth)) return true;
    }
  }
  return false;
}

// Fail fast on insecure defaults in production.
if (process.env.NODE_ENV === 'production') {
  if ((process.env.WORKER_TOKEN_PEPPER ?? 'dev_pepper_change_me') === 'dev_pepper_change_me') {
    throw new Error('WORKER_TOKEN_PEPPER must be set in production');
  }
  if (VERIFIER_TOKEN_PEPPER === 'dev_pepper_change_me') {
    throw new Error('VERIFIER_TOKEN_PEPPER must be set in production');
  }
  if (ADMIN_TOKEN_PEPPER === 'dev_pepper_change_me') {
    throw new Error('ADMIN_TOKEN_PEPPER must be set in production');
  }
  if (!VERIFIER_TOKEN_HASH && VERIFIER_TOKEN === 'pw_vf_internal') {
    throw new Error('Set VERIFIER_TOKEN_HASH (and VERIFIER_TOKEN_PEPPER) in production');
  }
  if (!ADMIN_TOKEN_HASH && ADMIN_TOKEN === 'pw_adm_internal') {
    throw new Error('Set ADMIN_TOKEN_HASH (and ADMIN_TOKEN_PEPPER) in production');
  }
}

// Build Fastify with Zod provider
export function buildServer() {
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Preserve raw JSON body for webhook signature verification, while still providing parsed JSON to handlers.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    try {
      const buf = body as Buffer;
      (req as any).rawBody = buf;
      const text = buf.toString('utf8');
      done(null, text.length ? JSON.parse(text) : {});
    } catch (err) {
      done(err as any, undefined);
    }
  });

  app.addHook('onRequest', async () => {
    inc('requests_total', 1);
  });

  function enforceHttpsForApi(): boolean {
    // Default: enforce HTTPS for /api/* in production, unless explicitly disabled (router-mode / dev).
    const raw = String(process.env.ENFORCE_HTTPS ?? '').trim().toLowerCase();
    if (raw === 'false' || raw === '0' || raw === 'no') return false;
    if (raw === 'true' || raw === '1' || raw === 'yes') return true;
    return process.env.NODE_ENV === 'production';
  }

  // CORS + HTTPS enforcement (production)
  app.addHook('onRequest', async (request: any, reply: any) => {
    const origin = request.headers['origin'] as string | undefined;
    const globalAllowList = new Set(
      (process.env.CORS_ALLOW_ORIGINS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );

    // Always allow same-origin browser calls. The per-org allowlist is meant for third-party UIs
    // hosted on different origins; it must not break first-party UI served by this host.
    const xfProto = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
    const xfHost = String(request.headers['x-forwarded-host'] ?? '').split(',')[0].trim();
    const host = String(request.headers['host'] ?? '').split(',')[0].trim();
    const serverOrigin = (xfHost || host) ? `${xfProto || 'http'}://${xfHost || host}` : '';

    const corsCacheTtlMs = Number(process.env.ORG_CORS_CACHE_TTL_MS ?? 30_000);
    const cacheTtlMs = Number.isFinite(corsCacheTtlMs) ? Math.max(1000, Math.min(10 * 60_000, corsCacheTtlMs)) : 30_000;
    const now = Date.now();

    // Caches are scoped to the server instance.
    const tokenOrgCache: Map<string, { orgId: string; exp: number }> =
      ((app as any).__tokenOrgCache ??= new Map());
    const orgCorsCache: Map<string, { origins: string[]; exp: number }> =
      ((app as any).__orgCorsCache ??= new Map());
    const unionCorsCache: { origins: string[]; exp: number } =
      ((app as any).__unionCorsCache ??= { origins: [], exp: 0 });

    async function resolveOrgIdFromBuyerToken(token: string): Promise<string | null> {
      const cached = tokenOrgCache.get(token);
      if (cached && cached.exp > now) return cached.orgId;
      const apiKey = await getApiKey(token);
      if (!apiKey) return null;
      tokenOrgCache.set(token, { orgId: apiKey.orgId, exp: now + cacheTtlMs });
      return apiKey.orgId;
    }

    async function resolveOrgCorsOrigins(orgId: string): Promise<string[]> {
      const cached = orgCorsCache.get(orgId);
      if (cached && cached.exp > now) return cached.origins;
      const origins = (await getOrgCorsAllowOrigins(orgId)) ?? [];
      orgCorsCache.set(orgId, { origins, exp: now + cacheTtlMs });
      return origins;
    }

    async function resolveUnionCorsOrigins(): Promise<string[]> {
      if (unionCorsCache.exp > now) return unionCorsCache.origins;
      const origins = await listAllCorsAllowOrigins();
      unionCorsCache.origins = origins;
      unionCorsCache.exp = now + cacheTtlMs;
      return origins;
    }

    function setCorsHeaders(o: string) {
      reply.header('access-control-allow-origin', o);
      reply.header('vary', 'Origin');
      reply.header('access-control-allow-credentials', 'true');
      reply.header(
        'access-control-allow-headers',
        'Content-Type, Authorization, X-CSRF-Token, Stripe-Signature, Idempotency-Key'
      );
      reply.header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }

    if (origin) {
      let allow = origin === serverOrigin || globalAllowList.has(origin);
      const auth = String(request.headers['authorization'] ?? '');
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const isBuyerToken = token.startsWith('pw_bu_');

      if (!allow && token && isBuyerToken) {
        const orgId = await resolveOrgIdFromBuyerToken(token);
        if (orgId) {
          const orgAllow = await resolveOrgCorsOrigins(orgId);
          allow = orgAllow.includes(origin);
        }
      }

      if (String(request.method).toUpperCase() === 'OPTIONS') {
        // Preflight cannot carry auth, so allow if:
        // - global allowlist, OR
        // - origin is in any org's allowlist (union). Actual request still enforces per-org.
        if (!allow) {
          const union = await resolveUnionCorsOrigins();
          allow = union.includes(origin);
        }
        if (allow) {
          setCorsHeaders(origin);
          reply.code(204).send();
          return;
        }
      } else {
        if (allow) {
          setCorsHeaders(origin);
        } else if (request.url?.startsWith('/api') && !request.url.startsWith('/api/webhooks/') && token && isBuyerToken) {
          // Enforce per-org browser origins for buyer tokens (3P UIs).
          reply.code(403).send({ error: { code: 'cors_forbidden', message: 'Origin is not allowlisted for this org' } });
          return;
        }
      }
    }

    if (enforceHttpsForApi()) {
      const proto = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
      if (request.url?.startsWith('/api') && !request.url.startsWith('/api/webhooks/') && proto && proto !== 'https') {
        reply.code(400).send({ error: { code: 'https_required', message: 'HTTPS required' } });
        return;
      }
    }
  });

  // Security headers
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('permissions-policy', 'geolocation=(), microphone=(), camera=()');
    const ct = String(reply.getHeader('content-type') ?? '');
    if (ct.includes('text/html')) {
      reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    }
    const proto = String((request as any)?.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim();
    const debugHeaders = ['true', '1', 'yes'].includes(String(process.env.DEBUG_RESPONSE_HEADERS ?? '').trim().toLowerCase());
    if (debugHeaders) {
      reply.header('x-debug-x-forwarded-proto', proto || '(none)');
      reply.header('x-debug-enforce-https', enforceHttpsForApi() ? '1' : '0');
      reply.header('x-debug-node-env', String(process.env.NODE_ENV ?? ''));
    }
    if (process.env.NODE_ENV === 'production' && proto === 'https') {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    return payload;
  });

  // Static portals
  app.register(fastifyStatic, {
    root: path.resolve(process.cwd(), 'public'),
    prefix: '/',
  });
  // Serve JSON schemas (descriptor)
  app.register(fastifyStatic, {
    root: path.resolve(process.cwd(), 'contracts'),
    prefix: '/contracts/',
    decorateReply: false,
    index: false,
  });
  // Serve runbooks/docs (read-only static). Useful for third-party onboarding and ops.
  app.get('/docs', async (_req, reply) => reply.redirect('/docs/'));
  app.get('/docs/openapi.yaml', async (_req, reply) => {
    try {
      const p = path.resolve(process.cwd(), 'openapi.yaml');
      const body = await readFile(p, 'utf8');
      reply.header('content-type', 'text/yaml; charset=utf-8');
      return reply.send(body);
    } catch {
      return reply.code(404).send('not found');
    }
  });
  app.register(fastifyStatic, {
    root: path.resolve(process.cwd(), 'docs'),
    prefix: '/docs/',
    decorateReply: false,
    index: ['index.html'],
  });

  // Dynamic app page for registry apps (works even when no static /public/apps/<slug>/ folder exists).
  // Built-in apps can still ship custom UIs under /public/apps/<slug>/ and set dashboard_url accordingly.
  let appPageTemplateCache: string | null = null;
  async function getAppPageTemplate(): Promise<string> {
    if (appPageTemplateCache) return appPageTemplateCache;
    const p = path.resolve(process.cwd(), 'public/apps/app_page.html');
    appPageTemplateCache = await readFile(p, 'utf8');
    return appPageTemplateCache;
  }

  const renderRegistryAppPage = async (request: any, reply: any) => {
    const slug = String(request.params.slug ?? '');
    const rec = await getPublicAppBySlug(slug);
    if (!rec) return reply.code(404).send('not found');

    const d: any = rec.defaultDescriptor ?? {};
    const cfg = {
      title: rec.name,
      titlePrefix: rec.name,
      description: rec.description ?? '',
      taskType: rec.taskType,
      defaultCaps: Array.isArray(d.capability_tags) ? d.capability_tags : [],
      defaultFreshnessSlaSec: typeof d.freshness_sla_sec === 'number' ? d.freshness_sla_sec : undefined,
      defaultInputSpec: d.input_spec ?? {},
      defaultOutputSpec: d.output_spec ?? {},
    };

    const tpl = await getAppPageTemplate();
    const html = tpl.replace('<script id="appConfig" type="application/json">{}</script>', `<script id="appConfig" type="application/json">${JSON.stringify(cfg)}</script>`);
    reply.header('content-type', 'text/html; charset=utf-8');
    return reply.send(html);
  };

  app.get('/apps/app/:slug', renderRegistryAppPage);
  app.get('/apps/app/:slug/', renderRegistryAppPage);

  app.get('/worker', async (_req, reply) => reply.redirect('/worker/index.html'));
  app.get('/buyer', async (_req, reply) => reply.redirect('/buyer/index.html'));
  app.get('/admin', async (_req, reply) => reply.redirect('/admin/index.html'));

  // Raw upload bodies (local storage backend)
  app.addContentTypeParser(
    // NOTE: Do not include application/json here; Fastify has a built-in JSON parser.
    // For JSON file uploads we accept parsed objects/strings and re-serialize in the upload handlers.
    ['image/png', 'image/jpeg', 'application/pdf', 'text/plain', 'application/zip', 'video/mp4', 'application/octet-stream'],
    { parseAs: 'buffer' },
    (req, body, done) => {
      done(null, body);
    }
  );

  app.addHook('onReady', async () => {
    await runMigrations();
    // Built-in apps are required for /apps and admin dashboards even when demo seeding is disabled.
    await seedBuiltInApps();
    if (shouldSeedDemoData()) {
      await seedDemoData();
      await seedBuyer();
    }
  });

  // Simple decorators
  app.decorate('authenticateWorker', async (request: any, reply: any) => {
    const auth = request.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) {
      reply.code(401).send({ error: { code: 'unauthorized', message: 'Missing bearer token' } });
      return;
    }
    const token = auth.substring('Bearer '.length).trim();
    const worker = await getWorkerByToken(token);
    if (!worker || worker.status !== 'active') {
      reply.code(401).send({ error: { code: 'unauthorized', message: 'Invalid worker token' } });
      return;
    }
    if (worker.rateLimitedUntil && worker.rateLimitedUntil > Date.now()) {
      reply.code(429).send({ error: { code: 'rate_limited', message: 'Worker temporarily rate limited' } });
      return;
    }
    if (!(await rateLimit(`worker:${worker.id}:global`, 120))) {
      reply.code(429).send({ error: { code: 'rate_limited', message: 'Rate limited' } });
      return;
    }

    const routeKey = (request as any).routeOptions?.url ?? request.url;
    if (!(await rateLimit(`worker:${worker.id}:route:${routeKey}`, 60))) {
      reply.code(429).send({ error: { code: 'rate_limited', message: 'Rate limited' } });
      return;
    }
    request.worker = worker;
  });

  app.decorate('authenticateVerifier', async (request: any, reply: any) => {
    const auth = request.headers['authorization'];
    const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
    const ok = VERIFIER_TOKEN_HASH ? hmacSha256Hex(token ?? '', VERIFIER_TOKEN_PEPPER) === VERIFIER_TOKEN_HASH : token === VERIFIER_TOKEN;
    if (!ok) {
      reply.code(401).send({ error: { code: 'unauthorized', message: 'Invalid verifier token' } });
      return;
    }

    const routeKey = (request as any).routeOptions?.url ?? request.url;
    if (!(await rateLimit(`verifier:global`, 600))) {
      reply.code(429).send({ error: { code: 'rate_limited', message: 'Rate limited' } });
      return;
    }
    if (!(await rateLimit(`verifier:route:${routeKey}`, 600))) {
      reply.code(429).send({ error: { code: 'rate_limited', message: 'Rate limited' } });
      return;
    }
  });

  app.decorate('authenticateBuyer', async (request: any, reply: any) => {
    // Prefer cookie session if present.
    const cookies = parseCookies(request.headers['cookie'] as string | undefined);
    const sessCookie = cookies['pw_sess'];
    if (sessCookie) {
      const sessId = verifySessionCookie(sessCookie);
      if (!sessId) {
        reply.code(401).send({ error: { code: 'unauthorized', message: 'Invalid session' } });
        return;
      }
      const sess = await getSession(sessId);
      if (!sess) {
        reply.code(401).send({ error: { code: 'unauthorized', message: 'Session expired' } });
        return;
      }

      request.orgId = sess.orgId;
      request.userId = sess.userId;
      request.role = sess.role;
      request.sessionId = sess.id;
      request.csrfSecret = sess.csrfSecret;

      const routeKey = (request as any).routeOptions?.url ?? request.url;
      if (!(await rateLimit(`buyer_sess:${sess.id}:global`, 240))) {
        reply.code(429).send({ error: { code: 'rate_limited', message: 'Rate limited' } });
        return;
      }
      if (!(await rateLimit(`buyer_sess:${sess.id}:route:${routeKey}`, 120))) {
        reply.code(429).send({ error: { code: 'rate_limited', message: 'Rate limited' } });
        return;
      }

      const unsafe = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(request.method).toUpperCase());
      if (unsafe) {
        const token = String(request.headers['x-csrf-token'] ?? '');
        if (!token || token !== csrfToken(sess.csrfSecret)) {
          reply.code(403).send({ error: { code: 'csrf', message: 'Missing/invalid CSRF token' } });
          return;
        }
      }

      return;
    }

    // Fallback: bearer API key (programmatic usage).
    const auth = request.headers['authorization'];
    const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
    if (!token) {
      reply.code(401).send({ error: { code: 'unauthorized', message: 'Missing buyer token or session' } });
      return;
    }
    const apiKey = await getApiKey(token);
    if (!apiKey) {
      reply.code(401).send({ error: { code: 'unauthorized', message: 'Invalid buyer token' } });
      return;
    }
    request.orgId = apiKey.orgId;
    request.apiKeyId = apiKey.id;

    const routeKey = (request as any).routeOptions?.url ?? request.url;
    if (!(await rateLimit(`buyer:${apiKey.id}:global`, 120))) {
      reply.code(429).send({ error: { code: 'rate_limited', message: 'Rate limited' } });
      return;
    }
    if (!(await rateLimit(`buyer:${apiKey.id}:route:${routeKey}`, 60))) {
      reply.code(429).send({ error: { code: 'rate_limited', message: 'Rate limited' } });
      return;
    }
  });

  app.decorate('authenticateAdmin', async (request: any, reply: any) => {
    const auth = request.headers['authorization'];
    const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
    const ok = ADMIN_TOKEN_HASH ? hmacSha256Hex(token ?? '', ADMIN_TOKEN_PEPPER) === ADMIN_TOKEN_HASH : token === ADMIN_TOKEN;
    if (!ok) {
      reply.code(401).send({ error: { code: 'unauthorized', message: 'Invalid admin token' } });
      return;
    }

    const routeKey = (request as any).routeOptions?.url ?? request.url;
    if (!(await rateLimit(`admin:global`, 600))) {
      reply.code(429).send({ error: { code: 'rate_limited', message: 'Rate limited' } });
      return;
    }
    if (!(await rateLimit(`admin:route:${routeKey}`, 600))) {
      reply.code(429).send({ error: { code: 'rate_limited', message: 'Rate limited' } });
      return;
    }
  });

  app.get('/health', async () => ({ ok: true }));
  app.get('/health/metrics', async (_req, reply) => {
    const txt = await renderPrometheusMetrics();
    reply.header('content-type', 'text/plain; version=0.0.4');
    return txt;
  });

  // Global search helpers (used by the shared UI shell).
  app.get('/api/admin/resolve', { preHandler: (app as any).authenticateAdmin }, async (request: any, reply) => {
    const q = (request.query ?? {}) as any;
    const id = String(q.id ?? '').trim();
    if (!id) return reply.code(400).send({ error: { code: 'invalid', message: 'id required' } });
    const res = await resolveIdAdmin(id);
    if (!res.found) return { found: false };
    return {
      found: true,
      type: res.type,
      meta: res.meta ?? {},
      href: `/admin/explorer.html?id=${encodeURIComponent(id)}`,
    };
  });

  app.get('/api/org/resolve', { preHandler: (app as any).authenticateBuyer }, async (request: any, reply) => {
    const q = (request.query ?? {}) as any;
    const id = String(q.id ?? '').trim();
    if (!id) return reply.code(400).send({ error: { code: 'invalid', message: 'id required' } });
    const res = await resolveIdOrg(request.orgId, id);
    if (!res.found) return { found: false };
    return {
      found: true,
      type: res.type,
      meta: res.meta ?? {},
      href: `/buyer/explorer.html?id=${encodeURIComponent(id)}`,
    };
  });

  app.get('/api/worker/resolve', { preHandler: (app as any).authenticateWorker }, async (request: any, reply) => {
    const q = (request.query ?? {}) as any;
    const id = String(q.id ?? '').trim();
    if (!id) return reply.code(400).send({ error: { code: 'invalid', message: 'id required' } });
    const res = await resolveIdWorker(request.worker.id, id);
    if (!res.found) return { found: false };
    return {
      found: true,
      type: res.type,
      meta: res.meta ?? {},
      href: `/worker/explorer.html?id=${encodeURIComponent(id)}`,
    };
  });

  // Public apps registry (partner-facing listing)
  app.get('/api/apps', async (request: any) => {
    const q = (request.query ?? {}) as any;
    const page = Math.max(1, Number(q.page ?? 1));
    const limit = Math.max(1, Math.min(200, Number(q.limit ?? 50)));
    const { rows, total } = await listPublicApps({ page, limit });
    return { apps: rows, page, limit, total };
  });

  app.get('/api/apps/:slug', async (request: any, reply) => {
    const slug = String(request.params.slug ?? '');
    const appRec = await getPublicAppBySlug(slug);
    if (!appRec) return reply.code(404).send({ error: { code: 'not_found', message: 'app not found' } });
    return { app: appRec };
  });

  // Secure artifact download (no public bucket required).
  app.get('/api/artifacts/:artifactId/download', async (request: any, reply) => {
    const auth = request.headers['authorization'];
    const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
    if (!token) return reply.code(401).send({ error: { code: 'unauthorized', message: 'Missing bearer token' } });

    // Determine actor type.
    const isVerifier = VERIFIER_TOKEN_HASH ? hmacSha256Hex(token, VERIFIER_TOKEN_PEPPER) === VERIFIER_TOKEN_HASH : token === VERIFIER_TOKEN;
    const isAdmin = ADMIN_TOKEN_HASH ? hmacSha256Hex(token, ADMIN_TOKEN_PEPPER) === ADMIN_TOKEN_HASH : token === ADMIN_TOKEN;

    const worker = !isVerifier && !isAdmin ? await getWorkerByToken(token) : undefined;
    const apiKey = !isVerifier && !isAdmin && !worker ? await getApiKey(token) : undefined;

    if (!isVerifier && !isAdmin && !worker && !apiKey) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'Invalid token' } });
    }

    const artifactId = request.params.artifactId as string;
    const art = await getArtifactAccessInfo(artifactId);
    if (!art || art.deletedAt) return reply.code(404).send({ error: { code: 'not_found', message: 'artifact not found' } });
    if (!art.storageKey) return reply.code(409).send({ error: { code: 'not_ready', message: 'artifact missing storage key' } });
    if (art.status === 'blocked') {
      return reply.code(422).send({
        error: {
          code: 'blocked',
          message: 'artifact blocked by scanner',
          status: art.status,
          scanReason: art.scanReason ?? null,
        },
      });
    }
    if (art.status !== 'scanned' && art.status !== 'accepted') {
      return reply.code(409).send({
        error: {
          code: 'not_ready',
          message: 'artifact not scanned yet',
          status: art.status,
          scanReason: art.scanReason ?? null,
        },
      });
    }

    // Authz
    if (worker) {
      if (!art.workerId || art.workerId !== worker.id) return reply.code(403).send({ error: { code: 'forbidden', message: 'forbidden' } });
    } else if (apiKey) {
      if (!art.orgId || art.orgId !== apiKey.orgId) return reply.code(403).send({ error: { code: 'forbidden', message: 'forbidden' } });
    } else {
      // admin/verifier allowed
    }

    // Local = proxy file; S3 = redirect to presigned GET.
    const backend = process.env.STORAGE_BACKEND ?? 'local';
    if (backend === 'local') {
      try {
        const { filePath } = localPathForStorageKey(art.storageKey);
        reply.header('content-type', art.contentType ?? 'application/octet-stream');
        return reply.send(createReadStream(filePath));
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        return reply.code(404).send({ error: { code: 'not_found', message: msg } });
      }
    }

    try {
      const url = await presignArtifactDownloadUrl(artifactId);
      return reply.redirect(url);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const code = msg.includes('not_scanned') || msg.includes('not_in_clean') ? 409 : 400;
      return reply.code(code).send({ error: { code: 'invalid', message: msg } });
    }
  });

  // Artifact status (authorized). Useful for debugging scan backlog / blocked artifacts.
  app.get('/api/artifacts/:artifactId', async (request: any, reply) => {
    const auth = request.headers['authorization'];
    const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
    if (!token) return reply.code(401).send({ error: { code: 'unauthorized', message: 'Missing bearer token' } });

    const isVerifier = VERIFIER_TOKEN_HASH ? hmacSha256Hex(token, VERIFIER_TOKEN_PEPPER) === VERIFIER_TOKEN_HASH : token === VERIFIER_TOKEN;
    const isAdmin = ADMIN_TOKEN_HASH ? hmacSha256Hex(token, ADMIN_TOKEN_PEPPER) === ADMIN_TOKEN_HASH : token === ADMIN_TOKEN;

    const worker = !isVerifier && !isAdmin ? await getWorkerByToken(token) : undefined;
    const apiKey = !isVerifier && !isAdmin && !worker ? await getApiKey(token) : undefined;
    if (!isVerifier && !isAdmin && !worker && !apiKey) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'Invalid token' } });
    }

    const artifactId = request.params.artifactId as string;
    const art = await getArtifactAccessInfo(artifactId);
    if (!art || art.deletedAt) return reply.code(404).send({ error: { code: 'not_found', message: 'artifact not found' } });

    // Authz (mirror /download)
    if (worker) {
      if (!art.workerId || art.workerId !== worker.id) return reply.code(403).send({ error: { code: 'forbidden', message: 'forbidden' } });
    } else if (apiKey) {
      if (!art.orgId || art.orgId !== apiKey.orgId) return reply.code(403).send({ error: { code: 'forbidden', message: 'forbidden' } });
    } else {
      // admin/verifier allowed
    }

    return {
      id: art.id,
      status: art.status,
      contentType: art.contentType,
      sizeBytes: art.sizeBytes,
      bucketKind: art.bucketKind,
      scanEngine: art.scanEngine,
      scanStartedAt: art.scanStartedAt,
      scanFinishedAt: art.scanFinishedAt,
      scanReason: art.scanReason,
      // Note: never return storage keys here (internal).
    };
  });

  // Lease reaper endpoint (manual trigger for tests/ops)
  app.post('/api/internal/reap-leases', async () => {
    const expired = await reapExpiredLeases();
    return { expired };
  });

  // Buyer auth: create cookie session (CSRF protected)
  app.post('/api/auth/login', async (request, reply) => {
    const { email, password } = request.body as any;
    if (!email || !password) return reply.code(400).send({ error: { code: 'invalid', message: 'email/password required' } });
    const user = await verifyPassword(email, password);
    if (!user) return reply.code(401).send({ error: { code: 'unauthorized', message: 'invalid credentials' } });
    const { createSession } = await import('./auth/sessions.js');
    const sess = await createSession({ userId: user.id, orgId: user.orgId, role: user.role });
    const proto = String((request.headers as any)?.['x-forwarded-proto'] ?? '').split(',')[0].trim();
    const secureEnv = String(process.env.SESSION_COOKIE_SECURE ?? '').trim().toLowerCase();
    const secure =
      secureEnv === 'true' || secureEnv === '1'
        ? true
        : secureEnv === 'false' || secureEnv === '0'
          ? false
          : process.env.NODE_ENV === 'production'
            ? proto === 'https'
            : false;
    reply.header('set-cookie', `pw_sess=${sess.cookieValue}; Path=/; HttpOnly; SameSite=Lax; ${secure ? 'Secure; ' : ''}Max-Age=${7 * 24 * 3600}`);
    return { ok: true, orgId: user.orgId, role: user.role, email: user.email, csrfToken: csrfToken(sess.csrfSecret) };
  });

  app.post('/api/auth/logout', async (request: any, reply: any) => {
    const cookies = parseCookies(request.headers['cookie'] as string | undefined);
    const sessCookie = cookies['pw_sess'];
    if (sessCookie) {
      const sessId = verifySessionCookie(sessCookie);
      if (sessId) {
        const { revokeSession } = await import('./auth/sessions.js');
        await revokeSession(sessId);
      }
    }
    reply.header('set-cookie', `pw_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return { ok: true };
  });

  // Org registration (self-serve): create org + owner user + initial API key.
  //
  // NOTE: This is intentionally minimal and designed for Proofwork-style platform onboarding.
  // Production deployments should add email verification / abuse controls as needed.
  app.post('/api/org/register', { schema: { body: orgRegisterSchema } }, async (request: any, reply: any) => {
    if (!(await rateLimit(`register:ip:${request.ip}`, 10))) {
      return reply.code(429).send({ error: { code: 'rate_limited', message: 'Rate limited' } });
    }
    const body = request.body as any;
    try {
      const created = await registerOrg({ orgName: body.orgName, email: body.email, password: body.password });
      const { apiKey, token } = await createOrgApiKey(created.orgId, String(body.apiKeyName ?? 'default'));

      await writeAuditEvent({
        actorType: 'anonymous',
        actorId: created.email,
        action: 'org.register',
        targetType: 'org',
        targetId: created.orgId,
        metadata: { orgName: body.orgName },
      });

      return { orgId: created.orgId, userId: created.userId, email: created.email, role: created.role, apiKey, token };
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const code = msg === 'email_already_registered' ? 409 : 400;
      return reply.code(code).send({ error: { code: 'invalid', message: msg } });
    }
  });

  // Buyer API key create/list (replace with proper user auth/session in production)
  app.post('/api/org/api-keys', async (request, reply) => {
    const { email, password, name } = request.body as any;
    const user = await verifyPassword(email, password);
    if (!user || (user.role !== 'owner' && user.role !== 'admin')) return reply.code(401).send({ error: { code: 'unauthorized', message: 'invalid credentials' } });
    const { apiKey, token } = await createOrgApiKey(user.orgId, name || 'default');
    return { apiKey, token };
  });

  // Origins
  app.post('/api/origins', { preHandler: (app as any).authenticateBuyer }, async (request: any, reply) => {
    const { origin, method } = request.body as any;
    if (!origin || !method) return reply.code(400).send({ error: { code: 'invalid', message: 'origin/method required' } });
    try {
      const rec = await addOrigin(request.orgId, origin, method);
      return { origin: rec, verification: { token: rec.token, instructions: `Add proof token ${rec.token} via method ${method}` } };
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (msg.startsWith('blocked_domain:')) {
        return reply.code(403).send({ error: { code: 'blocked_domain', message: msg } });
      }
      return reply.code(400).send({ error: { code: 'invalid', message: msg } });
    }
  });

  app.get('/api/origins', { preHandler: (app as any).authenticateBuyer }, async (request: any) => {
    return { origins: await listOrigins(request.orgId) };
  });

  app.post('/api/origins/:originId/check', { preHandler: (app as any).authenticateBuyer }, async (request: any, reply) => {
    const rec = await checkOrigin(request.params.originId as string);
    if (!rec) return reply.code(404).send({ error: { code: 'not_found', message: 'origin not found' } });
    return { origin: rec, debug: {} };
  });

  app.post('/api/origins/:originId/revoke', { preHandler: (app as any).authenticateBuyer }, async (request: any, reply) => {
    const rec = await revokeOrigin(request.params.originId as string);
    if (!rec) return reply.code(404).send({ error: { code: 'not_found', message: 'origin not found' } });
    return { origin: rec };
  });

  // Retention policies (buyer)
  app.get('/api/retention/policies', { preHandler: (app as any).authenticateBuyer }, async (request: any) => {
    const rows = await db
      .selectFrom('retention_policies')
      .selectAll()
      .where('org_id', '=', request.orgId)
      .orderBy('created_at', 'desc')
      .execute();
    return {
      policies: rows.map((r: any) => ({
        id: r.id,
        orgId: r.org_id,
        name: r.name,
        appliesTo: r.applies_to,
        maxAgeDays: r.max_age_days,
        createdAt: r.created_at,
      })),
    };
  });

  app.post('/api/retention/policies', { preHandler: (app as any).authenticateBuyer }, async (request: any, reply) => {
    const body = request.body as any;
    const appliesTo = String(body?.appliesTo ?? 'artifacts');
    const maxAgeDays = Number(body?.maxAgeDays);
    const name = String(body?.name ?? appliesTo);

    if (!['artifacts'].includes(appliesTo)) {
      return reply.code(400).send({ error: { code: 'invalid', message: 'Unsupported appliesTo' } });
    }
    if (!Number.isFinite(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 3650) {
      return reply.code(400).send({ error: { code: 'invalid', message: 'maxAgeDays must be 1..3650' } });
    }

    const id = nanoid(12);
    const now = new Date();
    const row = await db
      .insertInto('retention_policies')
      .values({
        id,
        org_id: request.orgId,
        name,
        applies_to: appliesTo,
        max_age_days: maxAgeDays,
        created_at: now,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'applies_to']).doUpdateSet({
          name,
          max_age_days: maxAgeDays,
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    await writeAuditEvent({
      actorType: 'buyer_api_key',
      actorId: request.apiKeyId ?? null,
      action: 'retention_policy.upsert',
      targetType: 'retention_policy',
      targetId: row.id,
      metadata: { appliesTo, maxAgeDays },
    });

    return { policy: row };
  });

  // Billing (buyer)
  app.get('/api/billing/account', { preHandler: (app as any).authenticateBuyer }, async (request: any) => {
    // Ensure account exists.
    await db
      .insertInto('billing_accounts')
      .values({
        id: `acct_${request.orgId}`,
        org_id: request.orgId,
        balance_cents: 0,
        currency: 'usd',
        created_at: new Date(),
        updated_at: new Date(),
      })
      .onConflict((oc) => oc.column('org_id').doNothing())
      .execute();

    const account = await db.selectFrom('billing_accounts').selectAll().where('org_id', '=', request.orgId).executeTakeFirst();
    return { account };
  });

  app.get('/api/billing/events', { preHandler: (app as any).authenticateBuyer }, async (request: any) => {
    const rows = await db
      .selectFrom('billing_events')
      .innerJoin('billing_accounts', 'billing_accounts.id', 'billing_events.account_id')
      .select([
        'billing_events.id as id',
        'billing_events.event_type as eventType',
        'billing_events.amount_cents as amountCents',
        'billing_events.metadata_json as metadata',
        'billing_events.created_at as createdAt',
      ])
      .where('billing_accounts.org_id', '=', request.orgId)
      .orderBy('billing_events.created_at', 'desc')
      .limit(100)
      .execute();
    return { events: rows };
  });

  // Stripe top-ups (buyer): create a Stripe Checkout Session to fund the billing account.
  app.post('/api/billing/topups/checkout', { preHandler: (app as any).authenticateBuyer }, async (request: any, reply) => {
    const body = request.body as any;
    const amountCents = Number(body?.amountCents ?? 0);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return reply.code(400).send({ error: { code: 'invalid', message: 'amountCents must be > 0' } });
    }

    const base = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
    const successUrl = String(body?.successUrl ?? `${base}/buyer`);
    const cancelUrl = String(body?.cancelUrl ?? `${base}/buyer`);

    const now = new Date();
    await db
      .insertInto('billing_accounts')
      .values({ id: `acct_${request.orgId}`, org_id: request.orgId, balance_cents: 0, currency: 'usd', created_at: now, updated_at: now })
      .onConflict((oc) => oc.column('org_id').doNothing())
      .execute();
    const acct = await db.selectFrom('billing_accounts').selectAll().where('org_id', '=', request.orgId).executeTakeFirstOrThrow();

    // Ensure Stripe customer exists.
    const existingCustomer = await db.selectFrom('stripe_customers').selectAll().where('org_id', '=', request.orgId).executeTakeFirst();
    const customerId =
      existingCustomer?.stripe_customer_id ??
      (await (async () => {
        const created = await stripeCreateCustomer({ orgId: request.orgId });
        await db
          .insertInto('stripe_customers')
          .values({ id: nanoid(12), org_id: request.orgId, stripe_customer_id: created.id, created_at: now })
          .onConflict((oc) => oc.column('org_id').doUpdateSet({ stripe_customer_id: created.id }))
          .execute();
        return created.id;
      })());

    // Internal payment intent record for reconciliation.
    const intentId = nanoid(12);
    await db
      .insertInto('payment_intents')
      .values({
        id: intentId,
        account_id: acct.id,
        provider: 'stripe',
        provider_ref: null,
        amount_cents: amountCents,
        status: 'created',
        created_at: now,
        updated_at: now,
      })
      .execute();

    const session = await stripeCreateCheckoutSession({
      customerId,
      amountCents,
      successUrl,
      cancelUrl,
      metadata: { orgId: request.orgId, accountId: acct.id, paymentIntentId: intentId },
    });

    await db
      .updateTable('payment_intents')
      .set({ provider_ref: session.id, status: 'pending', updated_at: new Date() })
      .where('id', '=', intentId)
      .execute();

    await writeAuditEvent({
      actorType: 'buyer_api_key',
      actorId: request.apiKeyId ?? null,
      action: 'billing.topup.checkout',
      targetType: 'payment_intent',
      targetId: intentId,
      metadata: { amountCents, stripeSessionId: session.id },
    });

    return { checkoutUrl: session.url, stripeSessionId: session.id, paymentIntentId: intentId };
  });

  // Stripe webhook (public): verifies signature + idempotently credits billing ledger.
  app.post('/api/webhooks/stripe', async (request: any, reply) => {
    const sig = request.headers['stripe-signature'] as string | undefined;
    const rawBody: Buffer | undefined = (request as any).rawBody;
    if (!rawBody) return reply.code(400).send({ error: { code: 'invalid', message: 'missing_raw_body' } });

    let evt: any;
    try {
      evt = verifyStripeWebhookSignature({ rawBody, signatureHeader: sig, webhookSecret: requireStripeWebhookSecret() });
    } catch (err: any) {
      return reply.code(400).send({ error: { code: 'invalid', message: String(err?.message ?? err) } });
    }

    // Insert webhook event idempotently.
    const inserted = await db
      .insertInto('stripe_webhook_events')
      .values({
        id: evt.id,
        event_type: evt.type,
        payload_json: evt,
        received_at: new Date(),
        processed_at: null,
        status: 'received',
        last_error: null,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .returning(['id'])
      .executeTakeFirst();
    if (!inserted) return { ok: true };

    try {
      await db.transaction().execute(async (trx) => {
        if (evt.type === 'checkout.session.completed') {
          const session = evt.data?.object as any;
          if (!session || session.payment_status !== 'paid') {
            await trx.updateTable('stripe_webhook_events').set({ status: 'ignored', processed_at: new Date() }).where('id', '=', evt.id).execute();
            return;
          }

          const md = (session.metadata ?? {}) as any;
          const orgId = md.orgId as string | undefined;
          const accountId = md.accountId as string | undefined;
          const paymentIntentId = md.paymentIntentId as string | undefined;
          const amountTotal = Number(session.amount_total ?? 0);
          const currency = String(session.currency ?? 'usd').toLowerCase();

          if (!orgId || !accountId || !paymentIntentId || !Number.isFinite(amountTotal) || amountTotal <= 0 || currency !== 'usd') {
            await trx
              .updateTable('stripe_webhook_events')
              .set({ status: 'failed', processed_at: new Date(), last_error: 'missing_required_metadata_or_amount' })
              .where('id', '=', evt.id)
              .execute();
            return;
          }

          // Credit balance and record deterministic billing event id to guard against double-apply.
          const billingEventId = `stripe_evt_${evt.id}`;
          const existing = await trx.selectFrom('billing_events').select(['id']).where('id', '=', billingEventId).executeTakeFirst();
          if (!existing) {
            await trx
              .updateTable('billing_accounts')
              .set({ balance_cents: sql`balance_cents + ${amountTotal}`, updated_at: new Date() })
              .where('id', '=', accountId)
              .execute();

            await trx
              .insertInto('billing_events')
              .values({
                id: billingEventId,
                account_id: accountId,
                event_type: 'stripe_topup',
                amount_cents: amountTotal,
                metadata_json: { orgId, stripeEventId: evt.id, stripeSessionId: session.id },
                created_at: new Date(),
              })
              .execute();
          }

          await trx
            .updateTable('payment_intents')
            .set({ status: 'succeeded', provider_ref: session.id, updated_at: new Date() })
            .where('id', '=', paymentIntentId)
            .execute();

          await trx.updateTable('stripe_webhook_events').set({ status: 'processed', processed_at: new Date() }).where('id', '=', evt.id).execute();
          return;
        }

        await trx.updateTable('stripe_webhook_events').set({ status: 'ignored', processed_at: new Date() }).where('id', '=', evt.id).execute();
      });
    } catch (err: any) {
      await db
        .updateTable('stripe_webhook_events')
        .set({ status: 'failed', processed_at: new Date(), last_error: String(err?.message ?? err).slice(0, 5000) })
        .where('id', '=', evt.id)
        .execute();
      return reply.code(500).send({ error: { code: 'internal', message: 'webhook_processing_failed' } });
    }

    return { ok: true };
  });

  // Org settings (buyer): per-org platform fee (cut) configuration.
  app.get('/api/org/platform-fee', { preHandler: (app as any).authenticateBuyer }, async (request: any, reply) => {
    const settings = await getOrgPlatformFeeSettings(request.orgId);
    if (!settings) return reply.code(404).send({ error: { code: 'not_found', message: 'org not found' } });
    return {
      orgId: settings.orgId,
      platformFeeBps: settings.platformFeeBps,
      platformFeeWalletAddress: settings.platformFeeWalletAddress ?? null,
    };
  });

  app.put(
    '/api/org/platform-fee',
    { preHandler: (app as any).authenticateBuyer, schema: { body: orgPlatformFeeSchema } },
    async (request: any, reply) => {
      const role = request.role as string | undefined;
      if (role && !['owner', 'admin'].includes(role)) {
        return reply.code(403).send({ error: { code: 'forbidden', message: 'requires owner/admin' } });
      }

      const body = request.body as any;
      const maxBps = Number(process.env.MAX_ORG_PLATFORM_FEE_BPS ?? 5000);
      if (!Number.isFinite(maxBps) || maxBps < 0 || maxBps > 10_000) {
        return reply.code(500).send({ error: { code: 'misconfigured', message: 'MAX_ORG_PLATFORM_FEE_BPS invalid' } });
      }

      const bps = Number(body.platformFeeBps);
      if (!Number.isFinite(bps) || bps < 0 || bps > maxBps) {
        return reply
          .code(400)
          .send({ error: { code: 'invalid', message: `platformFeeBps must be 0..${maxBps}` } });
      }

      const walletRaw = body.platformFeeWalletAddress ?? null;
      let wallet: string | null = null;
      if (walletRaw !== null && walletRaw !== undefined && String(walletRaw).trim()) {
        try {
          wallet = getAddress(String(walletRaw).trim());
        } catch {
          return reply.code(400).send({ error: { code: 'invalid', message: 'platformFeeWalletAddress must be a valid EVM address' } });
        }
      }

      if (bps > 0 && !wallet) {
        return reply
          .code(400)
          .send({ error: { code: 'invalid', message: 'platformFeeWalletAddress is required when platformFeeBps > 0' } });
      }

      const updated = await setOrgPlatformFeeSettings(request.orgId, { platformFeeBps: bps, platformFeeWalletAddress: wallet });
      if (!updated) return reply.code(404).send({ error: { code: 'not_found', message: 'org not found' } });

      await writeAuditEvent({
        actorType: request.sessionId ? 'buyer_session' : 'buyer_api_key',
        actorId: request.sessionId ?? request.apiKeyId ?? null,
        action: 'org.platform_fee.update',
        targetType: 'org',
        targetId: request.orgId,
        metadata: { platformFeeBps: bps, platformFeeWalletAddress: wallet ? wallet.slice(0, 10) + '…' : null },
      });

      return {
        orgId: updated.orgId,
        platformFeeBps: updated.platformFeeBps,
        platformFeeWalletAddress: updated.platformFeeWalletAddress,
      };
    }
  );

  // Org settings (buyer): per-org CORS allowlist for third-party browser UIs.
  app.get('/api/org/cors-allow-origins', { preHandler: (app as any).authenticateBuyer }, async (request: any, reply) => {
    const origins = await getOrgCorsAllowOrigins(request.orgId);
    if (!origins) return reply.code(404).send({ error: { code: 'not_found', message: 'org not found' } });
    return { orgId: request.orgId, origins };
  });

  app.put(
    '/api/org/cors-allow-origins',
    { preHandler: (app as any).authenticateBuyer, schema: { body: orgCorsAllowlistSchema } },
    async (request: any, reply) => {
      const role = request.role as string | undefined;
      if (role && !['owner', 'admin'].includes(role)) {
        return reply.code(403).send({ error: { code: 'forbidden', message: 'requires owner/admin' } });
      }

      const body = request.body as any;
      const raw = Array.isArray(body?.origins) ? body.origins : [];
      const cleaned: string[] = [];
      for (const item of raw) {
        const s = String(item ?? '').trim();
        if (!s) continue;
        let u: URL;
        try {
          u = new URL(s);
        } catch {
          return reply.code(400).send({ error: { code: 'invalid', message: `invalid origin: ${s}` } });
        }
        if (!['http:', 'https:'].includes(u.protocol)) {
          return reply.code(400).send({ error: { code: 'invalid', message: `invalid origin protocol: ${u.protocol}` } });
        }
        cleaned.push(u.origin);
      }
      // de-dupe and cap
      const uniq = Array.from(new Set(cleaned));
      if (uniq.length > 100) return reply.code(400).send({ error: { code: 'invalid', message: 'too many origins (max 100)' } });

      const updated = await setOrgCorsAllowOrigins(request.orgId, uniq);
      if (!updated) return reply.code(404).send({ error: { code: 'not_found', message: 'org not found' } });

      await writeAuditEvent({
        actorType: request.sessionId ? 'buyer_session' : 'buyer_api_key',
        actorId: request.sessionId ?? request.apiKeyId ?? null,
        action: 'org.cors_allow_origins.update',
        targetType: 'org',
        targetId: request.orgId,
        metadata: { originsCount: uniq.length },
      });

      return { orgId: request.orgId, origins: updated };
    }
  );

  // Org settings (buyer): quotas / spend limits.
  app.get('/api/org/quotas', { preHandler: (app as any).authenticateBuyer }, async (request: any, reply) => {
    const settings = await getOrgQuotaSettings(request.orgId);
    if (!settings) return reply.code(404).send({ error: { code: 'not_found', message: 'org not found' } });
    return settings;
  });

  app.put(
    '/api/org/quotas',
    { preHandler: (app as any).authenticateBuyer, schema: { body: orgQuotasSchema } },
    async (request: any, reply) => {
      const role = request.role as string | undefined;
      if (role && !['owner', 'admin'].includes(role)) {
        return reply.code(403).send({ error: { code: 'forbidden', message: 'requires owner/admin' } });
      }

      const body = request.body as any;
      const patch: any = {};
      if (Object.prototype.hasOwnProperty.call(body, 'dailySpendLimitCents')) patch.dailySpendLimitCents = body.dailySpendLimitCents;
      if (Object.prototype.hasOwnProperty.call(body, 'monthlySpendLimitCents')) patch.monthlySpendLimitCents = body.monthlySpendLimitCents;
      if (Object.prototype.hasOwnProperty.call(body, 'maxOpenJobs')) patch.maxOpenJobs = body.maxOpenJobs;

      const updated = await setOrgQuotaSettings(request.orgId, patch);
      if (!updated) return reply.code(404).send({ error: { code: 'not_found', message: 'org not found' } });

      await writeAuditEvent({
        actorType: request.sessionId ? 'buyer_session' : 'buyer_api_key',
        actorId: request.sessionId ?? request.apiKeyId ?? null,
        action: 'org.quotas.update',
        targetType: 'org',
        targetId: request.orgId,
        metadata: { patchKeys: Object.keys(patch) },
      });

      return updated;
    }
  );

  // Apps registry (buyer): self-serve app definitions (no admin approval required).
  app.get('/api/org/apps', { preHandler: (app as any).authenticateBuyer }, async (request: any) => {
    const q = (request.query ?? {}) as any;
    const page = Math.max(1, Number(q.page ?? 1));
    const limit = Math.max(1, Math.min(200, Number(q.limit ?? 50)));
    const { rows, total } = await listAppsByOrg(request.orgId, { page, limit });
    return { apps: rows, page, limit, total };
  });

  app.post('/api/org/apps', { preHandler: (app as any).authenticateBuyer, schema: { body: appCreateSchema } }, async (request: any, reply) => {
    const role = request.role as string | undefined;
    if (role && !['owner', 'admin'].includes(role)) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'requires owner/admin' } });
    }

    const body = request.body as any;
    const slug = String(body.slug ?? '').trim();
    const taskType = String(body.taskType ?? '').trim();
    const name = String(body.name ?? '').trim();
    const description = body.description ?? null;
    const publicFlag = body.public === undefined ? true : Boolean(body.public);

    // Normalize dashboard URL: allow absolute URLs or local paths.
    let dashboardUrl: string | null = body.dashboardUrl ?? null;
    if (dashboardUrl !== null && dashboardUrl !== undefined && String(dashboardUrl).trim()) {
      const raw = String(dashboardUrl).trim();
      if (raw.startsWith('/')) dashboardUrl = raw;
      else {
        try {
          const u = new URL(raw);
          if (!['http:', 'https:'].includes(u.protocol)) {
            return reply.code(400).send({ error: { code: 'invalid', message: 'dashboardUrl must be http(s) or /path' } });
          }
          dashboardUrl = u.toString();
        } catch {
          return reply.code(400).send({ error: { code: 'invalid', message: 'dashboardUrl must be a valid URL or /path' } });
        }
      }
    } else {
      dashboardUrl = null;
    }

    let defaultDescriptor: any = body.defaultDescriptor ?? null;
    if (defaultDescriptor !== null && defaultDescriptor !== undefined) {
      if (!isTaskDescriptorEnabled()) {
        return reply.code(409).send({ error: { code: 'feature_disabled', message: 'task_descriptor is disabled' } });
      }
      const parsed = (taskDescriptorSchema as any).safeParse(defaultDescriptor);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: 'invalid_task_descriptor', message: parsed.error.message } });
      }
      if (String(parsed.data.type) !== taskType) {
        return reply.code(400).send({ error: { code: 'invalid', message: 'defaultDescriptor.type must match taskType' } });
      }
      const bytes = Buffer.byteLength(JSON.stringify(parsed.data), 'utf8');
      if (bytes > TASK_DESCRIPTOR_MAX_BYTES) {
        return reply.code(400).send({ error: { code: 'task_descriptor_too_large', message: `defaultDescriptor exceeds ${TASK_DESCRIPTOR_MAX_BYTES} bytes` } });
      }
      if (hasSensitiveKeys(parsed.data)) {
        return reply.code(400).send({ error: { code: 'task_descriptor_sensitive', message: 'defaultDescriptor contains sensitive keys' } });
      }
      defaultDescriptor = parsed.data;
    } else {
      defaultDescriptor = {};
    }

    let uiSchema: any = body.uiSchema ?? null;
    if (uiSchema !== null && uiSchema !== undefined) {
      const bytes = Buffer.byteLength(JSON.stringify(uiSchema), 'utf8');
      if (bytes > APP_UI_SCHEMA_MAX_BYTES) {
        return reply
          .code(400)
          .send({ error: { code: 'ui_schema_too_large', message: `uiSchema exceeds ${APP_UI_SCHEMA_MAX_BYTES} bytes` } });
      }
      if (hasSensitiveKeys(uiSchema)) {
        return reply.code(400).send({ error: { code: 'ui_schema_sensitive', message: 'uiSchema contains sensitive keys' } });
      }
    } else {
      uiSchema = {};
    }

    try {
      const appRec = await createOrgApp(request.orgId, {
        slug,
        taskType,
        name,
        description,
        dashboardUrl,
        public: publicFlag,
        defaultDescriptor,
        uiSchema,
      });

      await writeAuditEvent({
        actorType: request.sessionId ? 'buyer_session' : 'buyer_api_key',
        actorId: request.sessionId ?? request.apiKeyId ?? null,
        action: 'app.create',
        targetType: 'app',
        targetId: appRec.id,
        metadata: { slug, taskType, public: publicFlag },
      });

      return { app: appRec };
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      // Unique violations: slug or task_type collisions.
      if (String((err as any)?.code ?? '') === '23505') {
        return reply.code(409).send({ error: { code: 'conflict', message: 'app slug or taskType already exists' } });
      }
      return reply.code(500).send({ error: { code: 'internal', message: msg.slice(0, 200) } });
    }
  });

  app.patch('/api/org/apps/:appId', { preHandler: (app as any).authenticateBuyer, schema: { body: appUpdateSchema } }, async (request: any, reply) => {
    const role = request.role as string | undefined;
    if (role && !['owner', 'admin'].includes(role)) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'requires owner/admin' } });
    }

    const appId = String(request.params.appId ?? '');
    const body = request.body as any;
    const patch: any = {};
    if (body.slug !== undefined) patch.slug = String(body.slug).trim();
    if (body.taskType !== undefined) patch.taskType = String(body.taskType).trim();
    if (body.name !== undefined) patch.name = String(body.name).trim();
    if (body.description !== undefined) patch.description = body.description ?? null;
    if (body.public !== undefined) patch.public = Boolean(body.public);
    if (body.status !== undefined) patch.status = body.status;

    if (body.dashboardUrl !== undefined) {
      const raw = body.dashboardUrl;
      if (raw === null || raw === undefined || !String(raw).trim()) patch.dashboardUrl = null;
      else {
        const s = String(raw).trim();
        if (s.startsWith('/')) patch.dashboardUrl = s;
        else {
          try {
            const u = new URL(s);
            if (!['http:', 'https:'].includes(u.protocol)) {
              return reply.code(400).send({ error: { code: 'invalid', message: 'dashboardUrl must be http(s) or /path' } });
            }
            patch.dashboardUrl = u.toString();
          } catch {
            return reply.code(400).send({ error: { code: 'invalid', message: 'dashboardUrl must be a valid URL or /path' } });
          }
        }
      }
    }

    if (body.defaultDescriptor !== undefined) {
      if (!isTaskDescriptorEnabled()) {
        return reply.code(409).send({ error: { code: 'feature_disabled', message: 'task_descriptor is disabled' } });
      }
      const parsed = (taskDescriptorSchema as any).safeParse(body.defaultDescriptor);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: 'invalid_task_descriptor', message: parsed.error.message } });
      }
      const bytes = Buffer.byteLength(JSON.stringify(parsed.data), 'utf8');
      if (bytes > TASK_DESCRIPTOR_MAX_BYTES) {
        return reply.code(400).send({ error: { code: 'task_descriptor_too_large', message: `defaultDescriptor exceeds ${TASK_DESCRIPTOR_MAX_BYTES} bytes` } });
      }
      if (hasSensitiveKeys(parsed.data)) {
        return reply.code(400).send({ error: { code: 'task_descriptor_sensitive', message: 'defaultDescriptor contains sensitive keys' } });
      }
      patch.defaultDescriptor = parsed.data;
      if (patch.taskType && String(parsed.data.type) !== patch.taskType) {
        return reply.code(400).send({ error: { code: 'invalid', message: 'defaultDescriptor.type must match taskType when both are provided' } });
      }
    }

    if (body.uiSchema !== undefined) {
      const uiSchema: any = body.uiSchema;
      const bytes = Buffer.byteLength(JSON.stringify(uiSchema), 'utf8');
      if (bytes > APP_UI_SCHEMA_MAX_BYTES) {
        return reply
          .code(400)
          .send({ error: { code: 'ui_schema_too_large', message: `uiSchema exceeds ${APP_UI_SCHEMA_MAX_BYTES} bytes` } });
      }
      if (hasSensitiveKeys(uiSchema)) {
        return reply.code(400).send({ error: { code: 'ui_schema_sensitive', message: 'uiSchema contains sensitive keys' } });
      }
      patch.uiSchema = uiSchema;
    }

    try {
      const updated = await updateOrgApp(request.orgId, appId, patch);
      if (!updated) return reply.code(404).send({ error: { code: 'not_found', message: 'app not found' } });

      await writeAuditEvent({
        actorType: request.sessionId ? 'buyer_session' : 'buyer_api_key',
        actorId: request.sessionId ?? request.apiKeyId ?? null,
        action: 'app.update',
        targetType: 'app',
        targetId: appId,
        metadata: { patchKeys: Object.keys(patch) },
      });

      return { app: updated };
    } catch (err: any) {
      if (String((err as any)?.code ?? '') === '23505') {
        return reply.code(409).send({ error: { code: 'conflict', message: 'app slug or taskType already exists' } });
      }
      return reply.code(500).send({ error: { code: 'internal', message: 'update_failed' } });
    }
  });

  // Org financial visibility (buyer): earnings + payout history + disputes.
  app.get('/api/org/earnings', { preHandler: (app as any).authenticateBuyer }, async (request: any) => {
    return await getOrgEarningsSummary(request.orgId);
  });

  app.get('/api/org/payouts', { preHandler: (app as any).authenticateBuyer }, async (request: any) => {
    const q = (request.query ?? {}) as any;
    const page = Math.max(1, Number(q.page ?? 1));
    const limit = Math.max(1, Math.min(200, Number(q.limit ?? 50)));
    const status = typeof q.status === 'string' ? q.status : undefined;
    const taskType = typeof q.taskType === 'string' ? q.taskType : typeof q.task_type === 'string' ? q.task_type : undefined;

    const res = await listPayoutsByOrg(request.orgId, { page, limit, status, taskType });
    return { payouts: res.rows, page, limit, total: res.total };
  });

  app.get('/api/org/disputes', { preHandler: (app as any).authenticateBuyer }, async (request: any) => {
    const q = (request.query ?? {}) as any;
    const page = Math.max(1, Number(q.page ?? 1));
    const limit = Math.max(1, Math.min(200, Number(q.limit ?? 50)));
    const status = typeof q.status === 'string' ? q.status : undefined;
    const res = await listDisputesByOrg(request.orgId, { page, limit, status });
    return { disputes: res.rows, page, limit, total: res.total };
  });

  app.post(
    '/api/org/disputes',
    { preHandler: (app as any).authenticateBuyer, schema: { body: disputeCreateSchema } },
    async (request: any, reply) => {
      const body = request.body as any;
      try {
        const actorType = request.sessionId ? 'buyer_session' : 'buyer_api_key';
        const actorId = request.sessionId ?? request.apiKeyId ?? null;
        const dispute = await createDispute(
          request.orgId,
          { payoutId: body.payoutId, submissionId: body.submissionId, reason: body.reason },
          { actorType, actorId }
        );
        return { dispute };
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        const code =
          msg === 'missing_target' ? 400 :
          msg === 'target_not_found' ? 404 :
          msg === 'forbidden' ? 403 :
          msg === 'payout_already_paid' ? 409 :
          msg === 'payout_missing' ? 409 :
          msg === 'dispute_already_open' ? 409 :
          msg === 'dispute_window_disabled' ? 409 :
          msg === 'dispute_window_expired' ? 409 :
          400;
        return reply.code(code).send({ error: { code: 'invalid', message: msg } });
      }
    }
  );

  app.post('/api/org/disputes/:disputeId/cancel', { preHandler: (app as any).authenticateBuyer }, async (request: any, reply) => {
    const disputeId = String(request.params.disputeId ?? '');
    try {
      const actorType = request.sessionId ? 'buyer_session' : 'buyer_api_key';
      const actorId = request.sessionId ?? request.apiKeyId ?? null;
      const dispute = await cancelDispute(request.orgId, disputeId, { actorType, actorId });
      return { dispute };
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const code = msg === 'not_found' ? 404 : msg === 'forbidden' ? 403 : msg === 'not_open' ? 409 : 400;
      return reply.code(code).send({ error: { code: 'invalid', message: msg } });
    }
  });

  // Bounties
  app.get('/api/bounties', { preHandler: (app as any).authenticateBuyer }, async (request: any) => {
    const q = request.query || {};
    const page = q.page ? Number(q.page) : 1;
    const limit = q.limit ? Number(q.limit) : 50;
    const status = typeof q.status === 'string' ? q.status : undefined;
    const taskType = typeof q.task_type === 'string' ? q.task_type : undefined;
    const res = await listBountiesByOrg(request.orgId, { page, limit, status, taskType });
    return { bounties: res.rows, total: res.total, page, limit };
  });

  app.post('/api/bounties', { preHandler: (app as any).authenticateBuyer }, async (request: any, reply) => {
    const body = request.body as any;
    if (!body.title || !body.description || !Array.isArray(body.allowedOrigins) || body.allowedOrigins.length === 0) {
      return reply.code(400).send({ error: { code: 'invalid', message: 'title, description, allowedOrigins required' } });
    }
    const rawDescriptor = body.taskDescriptor ?? body.task_descriptor;
    let taskDescriptor: any | undefined;
    if (rawDescriptor !== undefined) {
      if (!isTaskDescriptorEnabled()) {
        return reply.code(409).send({ error: { code: 'feature_disabled', message: 'task_descriptor is disabled' } });
      }
      const parsed = (taskDescriptorSchema as any).safeParse(rawDescriptor);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: 'invalid_task_descriptor', message: parsed.error.message } });
      }
      const bytes = Buffer.byteLength(JSON.stringify(parsed.data), 'utf8');
      if (bytes > TASK_DESCRIPTOR_MAX_BYTES) {
        return reply
          .code(400)
          .send({ error: { code: 'task_descriptor_too_large', message: `task_descriptor exceeds ${TASK_DESCRIPTOR_MAX_BYTES} bytes` } });
      }
      if (hasSensitiveKeys(parsed.data)) {
        return reply.code(400).send({ error: { code: 'task_descriptor_sensitive', message: 'task_descriptor contains sensitive keys' } });
      }
      taskDescriptor = parsed.data;
    }

    // Enforce app/task_type ownership so other orgs cannot spoof another platform's task type.
    if (taskDescriptor?.type) {
      const type = String(taskDescriptor.type);
      const appRec = await getAppByTaskType(type);
      if (!appRec) {
        return reply.code(400).send({ error: { code: 'app_not_registered', message: 'taskDescriptor.type is not registered; create an app first' } });
      }
      if (appRec.status === 'disabled') {
        return reply.code(409).send({ error: { code: 'app_disabled', message: 'app is disabled' } });
      }
      const ownerOrgId = appRec.ownerOrgId;
      if (ownerOrgId !== request.orgId && ownerOrgId !== 'org_system') {
        return reply.code(403).send({ error: { code: 'forbidden', message: 'task type belongs to another org' } });
      }
    }

    // verify allowed origins belong to org
    const checks = await Promise.all(body.allowedOrigins.map((o: string) => originAllowed(request.orgId, o)));
    const allVerified = checks.every(Boolean);
    if (!allVerified) return reply.code(400).send({ error: { code: 'origin_not_verified', message: 'allowedOrigins must be verified' } });

    // Defense-in-depth: block global disallowed domains even if an origin was previously verified.
    try {
      await Promise.all(body.allowedOrigins.map((o: string) => assertUrlNotBlocked(o)));
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (msg.startsWith('blocked_domain:')) return reply.code(403).send({ error: { code: 'blocked_domain', message: msg } });
      return reply.code(400).send({ error: { code: 'invalid', message: msg } });
    }

    const payoutCents = Number(body.payoutCents ?? body.payout_cents ?? 1000);
    if (!Number.isFinite(payoutCents) || payoutCents <= 0) {
      return reply.code(400).send({ error: { code: 'invalid', message: 'payoutCents must be > 0' } });
    }
    const minPayoutCents = Number(process.env.MIN_PAYOUT_CENTS ?? 0);
    if (minPayoutCents > 0 && payoutCents < minPayoutCents) {
      return reply.code(400).send({ error: { code: 'min_payout', message: `payoutCents must be >= ${minPayoutCents}` } });
    }

    let bounty: any;
    try {
      bounty = await createBounty({ ...body, payoutCents, taskDescriptor, orgId: request.orgId });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (msg.startsWith('blocked_domain:')) {
        return reply.code(403).send({ error: { code: 'blocked_domain', message: msg } });
      }
      return reply.code(400).send({ error: { code: 'invalid', message: msg } });
    }
    await writeAuditEvent({
      actorType: 'buyer_api_key',
      actorId: request.apiKeyId ?? null,
      action: 'bounty.create',
      targetType: 'bounty',
      targetId: bounty.id,
      metadata: { orgId: request.orgId },
    });
    return bounty;
  });

  app.post('/api/bounties/:bountyId/publish', { preHandler: (app as any).authenticateBuyer }, async (request: any, reply) => {
    const bounty = await getBounty(request.params.bountyId as string);
    if (!bounty) return reply.code(404).send({ error: { code: 'not_found', message: 'bounty not found' } });
    if (bounty.orgId !== request.orgId) return reply.code(403).send({ error: { code: 'forbidden', message: 'wrong org' } });
    if (bounty.status !== 'draft' && bounty.status !== 'paused') return reply.code(409).send({ error: { code: 'bad_state', message: 'must be draft or paused' } });
    const checks = await Promise.all(bounty.allowedOrigins.map((o) => originAllowed(bounty.orgId, o)));
    const allVerified = checks.every(Boolean);
    if (!allVerified) return reply.code(400).send({ error: { code: 'origin_not_verified', message: 'allowedOrigins must be verified' } });

    try {
      await Promise.all(bounty.allowedOrigins.map((o) => assertUrlNotBlocked(o)));
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (msg.startsWith('blocked_domain:')) return reply.code(403).send({ error: { code: 'blocked_domain', message: msg } });
      return reply.code(400).send({ error: { code: 'invalid', message: msg } });
    }

    try {
      await publishBounty(bounty.id);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (msg === 'insufficient_funds') {
        return reply.code(409).send({ error: { code: 'insufficient_funds', message: 'Insufficient bounty budget' } });
      }
      if (msg === 'daily_spend_limit_exceeded') {
        return reply.code(409).send({ error: { code: 'daily_spend_limit_exceeded', message: 'Daily spend limit exceeded' } });
      }
      if (msg === 'monthly_spend_limit_exceeded') {
        return reply.code(409).send({ error: { code: 'monthly_spend_limit_exceeded', message: 'Monthly spend limit exceeded' } });
      }
      if (msg === 'max_open_jobs_exceeded') {
        return reply.code(409).send({ error: { code: 'max_open_jobs_exceeded', message: 'Max open jobs exceeded' } });
      }
      throw err;
    }
    await writeAuditEvent({
      actorType: 'buyer_api_key',
      actorId: request.apiKeyId ?? null,
      action: 'bounty.publish',
      targetType: 'bounty',
      targetId: bounty.id,
      metadata: { orgId: request.orgId },
    });
    return await getBounty(bounty.id);
  });

  app.post('/api/bounties/:bountyId/pause', { preHandler: (app as any).authenticateBuyer }, async (request: any, reply) => {
    const bounty = await getBounty(request.params.bountyId as string);
    if (!bounty) return reply.code(404).send({ error: { code: 'not_found', message: 'bounty not found' } });
    if (bounty.orgId !== request.orgId) return reply.code(403).send({ error: { code: 'forbidden', message: 'wrong org' } });
    const updated = await setBountyStatus(bounty.id, 'paused');
    await writeAuditEvent({
      actorType: 'buyer_api_key',
      actorId: request.apiKeyId ?? null,
      action: 'bounty.pause',
      targetType: 'bounty',
      targetId: bounty.id,
      metadata: { orgId: request.orgId },
    });
    return updated;
  });

  app.post('/api/bounties/:bountyId/close', { preHandler: (app as any).authenticateBuyer }, async (request: any, reply) => {
    const bounty = await getBounty(request.params.bountyId as string);
    if (!bounty) return reply.code(404).send({ error: { code: 'not_found', message: 'bounty not found' } });
    if (bounty.orgId !== request.orgId) return reply.code(403).send({ error: { code: 'forbidden', message: 'wrong org' } });
    const updated = await setBountyStatus(bounty.id, 'closed');
    await writeAuditEvent({
      actorType: 'buyer_api_key',
      actorId: request.apiKeyId ?? null,
      action: 'bounty.close',
      targetType: 'bounty',
      targetId: bounty.id,
      metadata: { orgId: request.orgId },
    });
    return updated;
  });

  app.get('/api/bounties/:bountyId/jobs', { preHandler: (app as any).authenticateBuyer }, async (request: any, reply) => {
    const bounty = await getBounty(request.params.bountyId as string);
    if (!bounty) return reply.code(404).send({ error: { code: 'not_found', message: 'bounty not found' } });
    if (bounty.orgId !== request.orgId) return reply.code(403).send({ error: { code: 'forbidden', message: 'wrong org' } });
    const q = request.query || {};
    const page = q.page ? Number(q.page) : 1;
    const limit = q.limit ? Number(q.limit) : 50;
    const status = typeof q.status === 'string' ? q.status : undefined;
    const res = await listJobsByBounty(bounty.id, { page, limit, status });
    return { bountyId: bounty.id, jobs: res.rows, total: res.total, page, limit };
  });

  // Session-based API key management for the buyer portal.
  app.get('/api/org/api-keys', { preHandler: (app as any).authenticateBuyer }, async (request: any, reply: any) => {
    if (!request.sessionId) return reply.code(403).send({ error: { code: 'forbidden', message: 'session required' } });
    const rows = await db
      .selectFrom('org_api_keys')
      .select(['id', 'name', 'key_prefix', 'created_at', 'revoked_at', 'last_used_at'])
      .where('org_id', '=', request.orgId)
      .orderBy('created_at', 'desc')
      .execute();
    return {
      apiKeys: rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        keyPrefix: r.key_prefix,
        createdAt: r.created_at,
        revokedAt: r.revoked_at ?? null,
        lastUsedAt: r.last_used_at ?? null,
      })),
    };
  });

  app.post('/api/session/api-keys', { preHandler: (app as any).authenticateBuyer }, async (request: any, reply: any) => {
    if (!request.sessionId) return reply.code(403).send({ error: { code: 'forbidden', message: 'session required' } });
    const name = String((request.body as any)?.name ?? 'portal');
    const { apiKey, token } = await createOrgApiKey(request.orgId, name);
    await writeAuditEvent({
      actorType: 'buyer_session',
      actorId: request.sessionId,
      action: 'api_key.create',
      targetType: 'org_api_key',
      targetId: apiKey.id,
      metadata: { name },
    });
    return { apiKey, token };
  });

  app.post('/api/session/api-keys/:apiKeyId/revoke', { preHandler: (app as any).authenticateBuyer }, async (request: any, reply: any) => {
    if (!request.sessionId) return reply.code(403).send({ error: { code: 'forbidden', message: 'session required' } });
    const apiKeyId = String(request.params.apiKeyId);
    const updated = await db
      .updateTable('org_api_keys')
      .set({ revoked_at: new Date() })
      .where('org_id', '=', request.orgId)
      .where('id', '=', apiKeyId)
      .returning(['id'])
      .executeTakeFirst();
    if (!updated) return reply.code(404).send({ error: { code: 'not_found', message: 'api key not found' } });
    await writeAuditEvent({
      actorType: 'buyer_session',
      actorId: request.sessionId,
      action: 'api_key.revoke',
      targetType: 'org_api_key',
      targetId: apiKeyId,
      metadata: {},
    });
    return { ok: true };
  });

  // Worker registration
  app.post('/api/workers/register', { schema: { body: registerWorkerSchema } }, async (request, reply) => {
    if (!(await rateLimit(`worker_register:ip:${(request as any).ip}`, 30))) {
      return reply.code(429).send({ error: { code: 'rate_limited', message: 'Rate limited' } });
    }
    const body = request.body as any;
    const { worker, token } = await createWorker(body.displayName, body.capabilities || {});
    return { workerId: worker.id, token };
  });

  app.get('/api/worker/me', { preHandler: (app as any).authenticateWorker }, async (request: any) => {
    const worker: Worker = request.worker;
    const row = await db
      .selectFrom('workers')
      .select(['payout_chain', 'payout_address', 'payout_address_verified_at'])
      .where('id', '=', worker.id)
      .executeTakeFirst();
    return {
      workerId: worker.id,
      status: worker.status,
      displayName: worker.displayName,
      capabilities: worker.capabilities,
      payout: {
        chain: row?.payout_chain ?? null,
        address: row?.payout_address ?? null,
        verifiedAt: row?.payout_address_verified_at ?? null,
      },
    };
  });

  // Worker payout address registration (Base)
  app.post(
    '/api/worker/payout-address/message',
    { preHandler: (app as any).authenticateWorker, schema: { body: workerPayoutAddressMessageSchema } },
    async (request: any, reply) => {
      const worker: Worker = request.worker;
      const body = request.body as any;
      const chain = String(body.chain);
      const address = String(body.address);

      if (chain !== 'base') return reply.code(400).send({ error: { code: 'invalid', message: 'Unsupported chain' } });
      let normalized: string;
      try {
        normalized = getAddress(address);
      } catch {
        return reply.code(400).send({ error: { code: 'invalid', message: 'Invalid address' } });
      }

      const message = `Proofwork payout address verification\nworkerId=${worker.id}\nchain=${chain}\naddress=${normalized}`;
      return { ok: true, chain, address: normalized, message };
    }
  );

  app.post(
    '/api/worker/payout-address',
    { preHandler: (app as any).authenticateWorker, schema: { body: workerPayoutAddressSchema } },
    async (request: any, reply) => {
      const worker: Worker = request.worker;
      const body = request.body as any;
      const chain = String(body.chain);
      const address = String(body.address);
      const signature = String(body.signature);

      if (chain !== 'base') return reply.code(400).send({ error: { code: 'invalid', message: 'Unsupported chain' } });
      let normalized: string;
      try {
        normalized = getAddress(address);
      } catch {
        return reply.code(400).send({ error: { code: 'invalid', message: 'Invalid address' } });
      }

      const message = `Proofwork payout address verification\nworkerId=${worker.id}\nchain=${chain}\naddress=${normalized}`;
      let recovered: string;
      try {
        recovered = getAddress(verifyMessage(message, signature));
      } catch {
        return reply.code(400).send({ error: { code: 'invalid', message: 'Invalid signature' } });
      }
      if (recovered.toLowerCase() !== normalized.toLowerCase()) {
        return reply.code(400).send({ error: { code: 'invalid', message: 'Signature does not match address' } });
      }

      await db
        .updateTable('workers')
        .set({
          payout_chain: chain,
          payout_address: normalized,
          payout_address_verified_at: new Date(),
          payout_address_proof: { message, signature, recovered },
        })
        .where('id', '=', worker.id)
        .execute();

      await writeAuditEvent({
        actorType: 'worker',
        actorId: worker.id,
        action: 'worker.payout_address.set',
        targetType: 'worker',
        targetId: worker.id,
        metadata: { chain, address: normalized },
      });

      // Unblock any pending payouts that were waiting on this worker to set a payout address,
      // and requeue payout execution (respecting hold_until).
      const nowMs = Date.now();
      const now = new Date(nowMs);
      const unblocked = await db.transaction().execute(async (trx) => {
        const rows = await trx
          .updateTable('payouts')
          .set({ blocked_reason: null, updated_at: now })
          .where('worker_id', '=', worker.id)
          .where('status', '=', 'pending')
          .where('blocked_reason', '=', 'worker_payout_address_missing')
          .returning(['id', 'hold_until'])
          .execute();

        for (const r of rows) {
          const hold = (r as any).hold_until as Date | null | undefined;
          const nextAt = hold && hold.getTime() > nowMs ? hold : now;
          await trx
            .insertInto('outbox_events')
            .values({
              id: nanoid(12),
              topic: 'payout.requested',
              idempotency_key: `payout:${r.id}`,
              payload: { payoutId: r.id, workerId: worker.id },
              status: 'pending',
              attempts: 0,
              available_at: nextAt,
              locked_at: null,
              locked_by: null,
              last_error: null,
              created_at: now,
              sent_at: null,
            })
            .onConflict((oc) =>
              oc.columns(['topic', 'idempotency_key']).doUpdateSet({
                status: 'pending',
                attempts: 0,
                available_at: nextAt,
                locked_at: null,
                locked_by: null,
                last_error: null,
                sent_at: null,
              })
            )
            .execute();
        }

        return rows.length;
      });

      if (unblocked > 0) {
        await writeAuditEvent({
          actorType: 'worker',
          actorId: worker.id,
          action: 'payout.unblock_on_payout_address_set',
          targetType: 'worker',
          targetId: worker.id,
          metadata: { unblockedPayouts: unblocked },
        });
      }

      return { ok: true, chain, address: normalized, unblockedPayouts: unblocked };
    }
  );

  // Worker payout visibility
  app.get('/api/worker/payouts', { preHandler: (app as any).authenticateWorker }, async (request: any) => {
    const worker: Worker = request.worker;
    const q = (request.query ?? {}) as any;
    const page = Math.max(1, Number(q.page ?? 1));
    const limit = Math.max(1, Math.min(200, Number(q.limit ?? 50)));
    const status = typeof q.status === 'string' ? q.status : undefined;
    const res = await listPayoutsByWorker(worker.id, { page, limit, status });
    return { payouts: res.rows, page, limit, total: res.total };
  });

  // jobs/next
  app.get('/api/jobs/next', { preHandler: (app as any).authenticateWorker }, async (request: any, reply) => {
    const worker: Worker = request.worker;
    const q = request.query || {};
    const capabilityTag =
      isTaskDescriptorEnabled() && typeof q.capability_tag === 'string' ? q.capability_tag : undefined;
    const taskType =
      isTaskDescriptorEnabled() && typeof q.task_type === 'string' ? q.task_type : undefined;
    const supportedCapabilityTags =
      isTaskDescriptorEnabled() && typeof q.capability_tags === 'string'
        ? q.capability_tags
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean)
        : undefined;
    const excludeJobIds =
      typeof q.exclude_job_ids === 'string'
        ? q.exclude_job_ids
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean)
            .slice(0, 50)
        : undefined;
    const minPayoutCents = q.min_payout_cents ? Number(q.min_payout_cents) : undefined;
    const active = await getActiveJobForWorker(worker.id);
    if (active) {
      return envelope('blocked', ['You already have an active job. Finish or wait for verification.'], {}, {}, { jobId: active.id });
    }
    if (isUniversalWorkerPaused()) {
      return envelope('idle', ['Worker intake paused; retry later.'], {}, {}, {});
    }
    if ((await verifierBacklog()) > MAX_VERIFIER_BACKLOG) {
      return envelope('idle', ['Verification backlog high; wait and retry later.'], {}, {}, {});
    }
    const maxVerAge = maxVerifierBacklogAgeSec();
    if (maxVerAge > 0) {
      const age = await verifierBacklogOldestAgeSec();
      if (age > maxVerAge) {
        return envelope('idle', [`Verification queue lag high (${Math.round(age)}s); wait and retry later.`], {}, {}, {});
      }
    }
    const maxOutboxAge = maxOutboxPendingAgeSec();
    if (maxOutboxAge > 0) {
      const age = await outboxOldestPendingAgeSec();
      if (age > maxOutboxAge) {
        return envelope('idle', [`Outbox queue lag high (${Math.round(age)}s); wait and retry later.`], {}, {}, {});
      }
    }
    const maxScanAge = maxArtifactScanBacklogAgeSec();
    if (maxScanAge > 0) {
      const age = await artifactScanBacklogOldestAgeSec();
      if (age > maxScanAge) {
        return envelope('idle', [`Scanner backlog high (${Math.round(age)}s); wait and retry later.`], {}, {}, {});
      }
    }
    const claimable = await findClaimableJob(worker, { capabilityTag, supportedCapabilityTags, minPayoutCents, taskType, excludeJobIds });
    if (!claimable) {
      return envelope('idle', ['No jobs available right now. Reply HEARTBEAT_OK.'], {}, {}, {});
    }
    const jobSpec = buildJobSpec(claimable.job, claimable.bounty);
    if (!isTaskDescriptorEnabled()) (jobSpec as any).taskDescriptor = undefined;
    return envelope('claimable', ['Claim this job with POST /api/jobs/{jobId}/claim'], jobSpec.constraints, jobSpec.submissionFormat, { job: jobSpec });
  });

  // claim
  app.post('/api/jobs/:jobId/claim', { preHandler: (app as any).authenticateWorker }, async (request: any, reply) => {
    const worker: Worker = request.worker;
    const jobId = request.params.jobId as string;
    const existing = await getActiveJobForWorker(worker.id);
    if (existing) {
      reply.code(409).send({ error: { code: 'already_claimed', message: 'Worker already has active job' } });
      return;
    }
    const job = await getJob(jobId);
    if (!job) {
      reply.code(404).send({ error: { code: 'not_found', message: 'Job not found' } });
      return;
    }
    const freshnessSlaSec = Number(((job.taskDescriptor as any)?.freshness_sla_sec as any) ?? 0);
    if (freshnessSlaSec > 0 && job.createdAt && Date.now() - job.createdAt > freshnessSlaSec * 1000) {
      reply.code(409).send({ error: { code: 'stale_job', message: 'Job is stale (freshness SLA exceeded)' } });
      return;
    }
    if (job.status !== 'open' && !isLeaseExpired(job.leaseExpiresAt)) {
      reply.code(409).send({ error: { code: 'not_available', message: 'Job already claimed' } });
      return;
    }
    const lease = await leaseJob(jobId, worker.id, LEASE_TTL_MS);
    if (!lease) {
      reply.code(409).send({ error: { code: 'not_available', message: 'Job could not be leased' } });
      return;
    }
    inc('claim_total', 1);
    const bounty = await getBountyOrThrow(job.bountyId);
    const jobSpec = buildJobSpec(lease, bounty);
    if (!isTaskDescriptorEnabled()) (jobSpec as any).taskDescriptor = undefined;
    return envelope('claimed', jobSpec.next_steps, jobSpec.constraints, jobSpec.submissionFormat, {
      job: jobSpec,
      leaseExpiresAt: lease.leaseExpiresAt,
      leaseNonce: lease.leaseNonce,
    });
  });

  // Early lease release (worker-side safety: refuse unsafe jobs without waiting for TTL expiry).
  app.post(
    '/api/jobs/:jobId/release',
    { preHandler: (app as any).authenticateWorker, schema: { body: releaseJobLeaseSchema } },
    async (request: any, reply: any) => {
      const worker: Worker = request.worker;
      const jobId = String(request.params.jobId);
      const body = request.body as any;
      const leaseNonce = String(body.leaseNonce ?? '');
      const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined;

      const released = await releaseJobLease(jobId, worker.id, leaseNonce);
      if (!released) {
        const job = await getJob(jobId);
        if (!job) return reply.code(404).send({ error: { code: 'not_found', message: 'Job not found' } });
        if (job.leaseWorkerId !== worker.id) {
          return reply.code(403).send({ error: { code: 'forbidden', message: 'Worker does not hold lease' } });
        }
        if (job.leaseNonce && job.leaseNonce !== leaseNonce) {
          return reply.code(403).send({ error: { code: 'forbidden', message: 'leaseNonce mismatch' } });
        }
        return reply.code(409).send({ error: { code: 'not_available', message: 'Job lease could not be released' } });
      }

      await writeAuditEvent({
        actorType: 'worker',
        actorId: worker.id,
        action: 'job.lease_release',
        targetType: 'job',
        targetId: jobId,
        metadata: { reason: reason ?? null },
      });

      return { ok: true };
    }
  );

  // presign uploads
  app.post('/api/uploads/presign', { preHandler: (app as any).authenticateWorker, schema: { body: presignRequestSchema } }, async (request: any, reply) => {
    const worker: Worker = request.worker;
    const body = request.body as any;

    const blockedTypes = blockedContentTypes();
    if (blockedTypes.length) {
      const blocked = (body.files ?? []).find((f: any) => {
        const ct = String(f?.contentType ?? '').toLowerCase();
        return ct && blockedTypes.includes(ct);
      });
      if (blocked) {
        return reply.code(400).send({ error: { code: 'blocked_content_type', message: `Blocked content type: ${blocked.contentType}` } });
      }
    }

    const job = await getJob(body.jobId);
    if (!job) return reply.code(404).send({ error: { code: 'not_found', message: 'Job not found' } });
    if (job.leaseWorkerId !== worker.id) return reply.code(409).send({ error: { code: 'not_owner', message: 'Worker does not hold lease' } });
    if (isLeaseExpired(job.leaseExpiresAt)) return reply.code(409).send({ error: { code: 'lease_expired', message: 'Lease expired' } });

    try {
      const { uploads } = await presignUploads({ jobId: body.jobId, workerId: worker.id, files: body.files, publicBaseUrl: publicBaseUrlForRequest(request) });
      return { uploads };
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      return reply.code(400).send({ error: { code: 'invalid', message: msg } });
    }
  });

  // Local upload endpoint for STORAGE_BACKEND=local
  app.put('/api/uploads/local/:artifactId', { preHandler: (app as any).authenticateWorker }, async (request: any, reply) => {
    const worker: Worker = request.worker;
    const artifactId = request.params.artifactId as string;
    const contentType = request.headers['content-type'] as string | undefined;

    // Fastify has a built-in JSON parser; when uploading JSON files we may receive an object here.
    const bytes: Buffer | null = (() => {
      const body: unknown = request.body;
      if (Buffer.isBuffer(body)) return body;
      if (typeof body === 'string') return Buffer.from(body, 'utf8');
      const ct = String(contentType ?? '').toLowerCase().split(';')[0].trim();
      if (ct === 'application/json') {
        try {
          return Buffer.from(JSON.stringify(body ?? null), 'utf8');
        } catch {
          return null;
        }
      }
      return null;
    })();

    if (!bytes) {
      return reply.code(400).send({ error: { code: 'invalid', message: 'Expected binary body' } });
    }

    try {
      await putLocalUpload({ artifactId, workerId: worker.id, bytes, contentType });
      return { ok: true };
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const code =
        msg === 'artifact_not_found' ? 404 :
        msg === 'forbidden' ? 403 :
        400;
      return reply.code(code).send({ error: { code: 'invalid', message: msg } });
    }
  });

  // Upload completion hook for STORAGE_BACKEND=s3 (worker calls this after PUT to the presigned URL).
  app.post(
    '/api/uploads/complete',
    { preHandler: (app as any).authenticateWorker, schema: { body: uploadCompleteSchema } },
    async (request: any, reply) => {
      const worker: Worker = request.worker;
      const body = request.body as any;

      const artifactId = body.artifactId as string;
      const artifact = await db.selectFrom('artifacts').selectAll().where('id', '=', artifactId).executeTakeFirst();
      if (!artifact || artifact.deleted_at) return reply.code(404).send({ error: { code: 'not_found', message: 'Artifact not found' } });
      if (artifact.worker_id && artifact.worker_id !== worker.id) {
        return reply.code(403).send({ error: { code: 'forbidden', message: 'forbidden' } });
      }
      if (!artifact.job_id) return reply.code(409).send({ error: { code: 'invalid', message: 'Artifact not associated with a job' } });

      const job = await getJob(artifact.job_id);
      if (!job) return reply.code(404).send({ error: { code: 'not_found', message: 'Job not found' } });
      if (job.leaseWorkerId !== worker.id) return reply.code(409).send({ error: { code: 'not_owner', message: 'Worker does not hold lease' } });
      if (isLeaseExpired(job.leaseExpiresAt)) return reply.code(409).send({ error: { code: 'lease_expired', message: 'Lease expired' } });

      // Local backend scans during PUT; this endpoint is primarily for S3 backends.
      if ((process.env.STORAGE_BACKEND ?? 'local') !== 's3') {
        return { ok: true, artifactId };
      }

      // Mark uploaded and enqueue a scan request.
      await db
        .updateTable('artifacts')
        .set({
          status: 'uploaded',
          sha256: body.sha256 ?? artifact.sha256,
          size_bytes: body.sizeBytes ?? artifact.size_bytes,
        })
        .where('id', '=', artifactId)
        .execute();

      await enqueueOutbox('artifact.scan.requested', { artifactId }, { idempotencyKey: `artifact_scan:${artifactId}` });
      return { ok: true, artifactId };
    }
  );

  // Verifier evidence uploads (presign + complete; local mode supports direct PUT like workers).
  app.post(
    '/api/verifier/uploads/presign',
    { preHandler: (app as any).authenticateVerifier, schema: { body: verifierPresignRequestSchema } },
    async (request: any, reply) => {
      const body = request.body as any;
      const submission = await getSubmission(body.submissionId);
      if (!submission) return reply.code(404).send({ error: { code: 'not_found', message: 'Submission not found' } });
      try {
        const { uploads } = await presignVerifierUploads({ submissionId: submission.id, jobId: submission.jobId, files: body.files, publicBaseUrl: publicBaseUrlForRequest(request) });
        return { uploads };
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        return reply.code(400).send({ error: { code: 'invalid', message: msg } });
      }
    }
  );

  app.put('/api/verifier/uploads/local/:artifactId', { preHandler: (app as any).authenticateVerifier }, async (request: any, reply) => {
    const artifactId = request.params.artifactId as string;
    const contentType = request.headers['content-type'] as string | undefined;

    const bytes: Buffer | null = (() => {
      const body: unknown = request.body;
      if (Buffer.isBuffer(body)) return body;
      if (typeof body === 'string') return Buffer.from(body, 'utf8');
      const ct = String(contentType ?? '').toLowerCase().split(';')[0].trim();
      if (ct === 'application/json') {
        try {
          return Buffer.from(JSON.stringify(body ?? null), 'utf8');
        } catch {
          return null;
        }
      }
      return null;
    })();

    if (!bytes) {
      return reply.code(400).send({ error: { code: 'invalid', message: 'Expected binary body' } });
    }
    try {
      await putVerifierLocalUpload({ artifactId, bytes, contentType });
      return { ok: true, artifactId };
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const code = msg === 'artifact_not_found' ? 404 : msg === 'forbidden' ? 403 : 400;
      return reply.code(code).send({ error: { code: 'invalid', message: msg } });
    }
  });

  app.post(
    '/api/verifier/uploads/complete',
    { preHandler: (app as any).authenticateVerifier, schema: { body: uploadCompleteSchema } },
    async (request: any, reply) => {
      const body = request.body as any;
      const artifactId = body.artifactId as string;
      const artifact = await db.selectFrom('artifacts').selectAll().where('id', '=', artifactId).executeTakeFirst();
      if (!artifact || artifact.deleted_at) return reply.code(404).send({ error: { code: 'not_found', message: 'Artifact not found' } });
      if (artifact.worker_id) return reply.code(403).send({ error: { code: 'forbidden', message: 'forbidden' } });
      if (!artifact.submission_id) return reply.code(409).send({ error: { code: 'invalid', message: 'Artifact not associated with a submission' } });

      // Local backend scans during PUT.
      if ((process.env.STORAGE_BACKEND ?? 'local') !== 's3') {
        return { ok: true, artifactId };
      }

      await db
        .updateTable('artifacts')
        .set({
          status: 'uploaded',
          sha256: body.sha256 ?? artifact.sha256,
          size_bytes: body.sizeBytes ?? artifact.size_bytes,
        })
        .where('id', '=', artifactId)
        .execute();

      await enqueueOutbox('artifact.scan.requested', { artifactId }, { idempotencyKey: `artifact_scan:${artifactId}` });
      return { ok: true, artifactId };
    }
  );

  // submit proof pack
  app.post('/api/jobs/:jobId/submit', { preHandler: (app as any).authenticateWorker, schema: { body: submitJobSchema } }, async (request: any, reply) => {
    const worker: Worker = request.worker;
    const jobId = request.params.jobId as string;
    const body = request.body as any;
    const job = await getJob(jobId);
    if (!job) return reply.code(404).send({ error: { code: 'not_found', message: 'Job not found' } });
    if (job.leaseWorkerId !== worker.id) return reply.code(409).send({ error: { code: 'not_owner', message: 'Worker does not hold lease' } });
    if (isLeaseExpired(job.leaseExpiresAt)) return reply.code(409).send({ error: { code: 'lease_expired', message: 'Lease expired' } });
    const jobRef = job;

    const idempotencyKeyRaw = String(request.headers['idempotency-key'] ?? '').trim();
    const idempotencyKey = idempotencyKeyRaw ? idempotencyKeyRaw : undefined;
    if (idempotencyKey && idempotencyKey.length > 200) {
      return reply.code(400).send({ error: { code: 'invalid', message: 'Idempotency-Key too long' } });
    }
    const requestHash = sha256(
      JSON.stringify({
        manifest: body.manifest,
        artifactIndex: body.artifactIndex ?? [],
        notes: body.notes ?? null,
      })
    );

    async function respondWithExistingSubmission(existing: Submission) {
      // Best-effort: ensure the job points at the submission (heals crash windows).
      if (!jobRef.currentSubmissionId) {
        jobRef.currentSubmissionId = existing.id;
        if (jobRef.status === 'claimed' || jobRef.status === 'open') jobRef.status = 'verifying';
        await updateJob(jobRef);
      }

      const latestVer = await db
        .selectFrom('verifications')
        .select(['id'])
        .where('submission_id', '=', existing.id)
        .orderBy('attempt_no', 'desc')
        .executeTakeFirst();

      const state = jobRef.status === 'done' ? 'done' : 'verifying';
      return envelope(state, state === 'done' ? ['Job already completed.'] : ['Await verification result.'], {}, {}, {
        jobStatus: jobRef,
        submission: existing,
        verificationId: latestVer?.id ?? null,
      });
    }

    // Idempotency path 1: job already has a submission.
    if (job.currentSubmissionId) {
      const existing = await getSubmission(job.currentSubmissionId);
      if (existing && existing.workerId === worker.id) {
        return await respondWithExistingSubmission(existing);
      }
    }

    // Idempotency path 2: Idempotency-Key header maps to an existing submission.
    if (idempotencyKey) {
      const existing = await findSubmissionByIdempotency({ jobId, workerId: worker.id, idempotencyKey });
      if (existing) {
        if (existing.requestHash && existing.requestHash !== requestHash) {
          return reply.code(409).send({ error: { code: 'idempotency_conflict', message: 'Idempotency-Key reuse with different payload' } });
        }

        // Best-effort: attach artifacts and ensure verification exists/enqueued.
        try {
          await attachSubmissionArtifacts({
            submissionId: existing.id,
            jobId,
            workerId: worker.id,
            artifactIndex: body.artifactIndex ?? [],
          });
        } catch (err: any) {
          const msg = String(err?.message ?? err);
          return reply.code(400).send({ error: { code: 'invalid_artifact', message: msg } });
        }

        const existingVer = await findVerificationBySubmission(existing.id, 1);
        if (!existingVer) {
          const verification: Verification = { id: nanoid(12), submissionId: existing.id, attemptNo: 1, status: 'queued' };
          await addVerification(verification);
          await enqueueOutbox(
            'verification.requested',
            { verificationId: verification.id, submissionId: existing.id, attemptNo: 1 },
            { idempotencyKey: `verification:${existing.id}:1` }
          );
        } else if (existingVer.status === 'queued') {
          await enqueueOutbox(
            'verification.requested',
            { verificationId: existingVer.id, submissionId: existing.id, attemptNo: 1 },
            { idempotencyKey: `verification:${existing.id}:1` }
          );
        }

        // Ensure job status is consistent.
        if (job.status === 'claimed' || job.status === 'open') {
          job.status = 'verifying';
          job.currentSubmissionId = existing.id;
          await updateJob(job);
        }

        return await respondWithExistingSubmission(existing);
      }
    }

    // Enforce freshness SLA at submission time for descriptor-backed jobs.
    // Note: this must run *after* idempotency checks so retries can return the existing submission.
    const freshnessSlaSec = Number(((job.taskDescriptor as any)?.freshness_sla_sec as any) ?? 0);
    if (freshnessSlaSec > 0 && job.createdAt && Date.now() - job.createdAt > freshnessSlaSec * 1000) {
      return reply.code(409).send({ error: { code: 'stale_job', message: 'Job is stale (freshness SLA exceeded)' } });
    }

    const manifest = body.manifest;
    // basic origin check
    const bounty = await getBountyOrThrow(job.bountyId);
    if (manifest.finalUrl) {
      let origin: string;
      try {
        origin = new URL(String(manifest.finalUrl)).origin;
      } catch {
        return reply.code(400).send({ error: { code: 'invalid', message: 'finalUrl must be a valid URL' } });
      }
      const ok = bounty.allowedOrigins.includes(origin);
      if (!ok) return reply.code(400).send({ error: { code: 'origin_violation', message: 'finalUrl outside allowedOrigins' } });
    }

    const dedupeKey = sha256(`${manifest.bountyId}|${manifest.result.observed.slice(0, 200)}`);
    const duplicate = await findDuplicate(bounty.id, dedupeKey);

    const submissionId = nanoid(12);
    const submission: Submission = {
      id: submissionId,
      jobId,
      workerId: worker.id,
      idempotencyKey,
      requestHash,
      manifest,
      artifactIndex: body.artifactIndex,
      status: duplicate ? 'duplicate' : 'submitted',
      dedupeKey,
      createdAt: Date.now(),
      payoutStatus: 'none',
    };
    await addSubmission(submission);
    inc('submit_total', 1);

    // Attach internal artifacts (best-effort; external URLs are ignored for now).
    try {
      await attachSubmissionArtifacts({
        submissionId: submission.id,
        jobId,
        workerId: worker.id,
        artifactIndex: body.artifactIndex ?? [],
      });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      return reply.code(400).send({ error: { code: 'invalid_artifact', message: msg } });
    }

    job.currentSubmissionId = submission.id;

    if (duplicate) {
      inc('duplicate_total', 1);
      job.status = 'done';
      job.finalVerdict = 'fail';
      job.finalQualityScore = 0;
      await updateJob(job);
      return envelope('done', ['Duplicate detected; no payout.'], {}, {}, { jobStatus: job, submission });
    }

    // enqueue verification (simplified: create record queued)
    const verification: Verification = {
      id: nanoid(12),
      submissionId: submission.id,
      attemptNo: 1,
      status: 'queued',
    };
    await addVerification(verification);
    await enqueueOutbox(
      'verification.requested',
      {
        verificationId: verification.id,
        submissionId: submission.id,
        attemptNo: verification.attemptNo,
      },
      { idempotencyKey: `verification:${submission.id}:${verification.attemptNo}` }
    );

    job.status = 'verifying';
    await updateJob(job);

    return envelope('verifying', ['Await verification result.'], {}, {}, {
      jobStatus: job,
      submission,
      verificationId: verification.id,
    });
  });

  // job status
  app.get('/api/jobs/:jobId', { preHandler: (app as any).authenticateWorker }, async (request: any, reply) => {
    const worker: Worker = request.worker;
    const job = await getJob(request.params.jobId as string);
    if (!job) return reply.code(404).send({ error: { code: 'not_found', message: 'Job not found' } });
    if (job.leaseWorkerId !== worker.id) return reply.code(404).send({ error: { code: 'not_found', message: 'Job not found' } });
    return job;
  });

  // verifier claim
  app.post('/api/verifier/claim', { preHandler: (app as any).authenticateVerifier, schema: { body: verifierClaimSchema } }, async (request: any, reply) => {
    const body = request.body as any;
    const submission = await getSubmission(body.submissionId);
    if (!submission) return reply.code(404).send({ error: { code: 'not_found', message: 'Submission not found' } });
    let verification = await findVerificationBySubmission(body.submissionId, body.attemptNo);
    if (!verification) {
      verification = {
        id: nanoid(12),
        submissionId: submission.id,
        attemptNo: body.attemptNo,
        status: 'queued',
      };
      await addVerification(verification);
    }
    if (verification.status === 'in_progress' && verification.claimExpiresAt && verification.claimExpiresAt > Date.now()) {
      return reply.code(409).send({ error: { code: 'claimed', message: 'Already claimed' } });
    }
    verification.status = 'in_progress';
    verification.claimToken = nanoid(16);
    verification.claimedBy = body.verifierInstanceId;
    verification.claimExpiresAt = Date.now() + body.claimTtlSec * 1000;
    await updateVerification(verification);

    const job = await getJob(submission.jobId);
    if (!job) return reply.code(404).send({ error: { code: 'not_found', message: 'Job missing' } });
    const bounty = await getBountyOrThrow(job.bountyId);
    const jobSpec = buildJobSpec(job, bounty);
    if (!isTaskDescriptorEnabled()) (jobSpec as any).taskDescriptor = undefined;

    // Prefer canonical, internal artifacts from the DB (defense-in-depth against external URLs in artifactIndex).
    const artifactIndex = await db
      .selectFrom('artifacts')
      .select(['kind', 'label', 'sha256', 'final_url as url', 'size_bytes as sizeBytes', 'content_type as contentType'])
      .where('submission_id', '=', submission.id)
      .where('deleted_at', 'is', null)
      .orderBy('created_at', 'asc')
      .execute();

    return {
      verificationId: verification.id,
      claimToken: verification.claimToken,
      jobSpec,
      submission: {
        submissionId: submission.id,
        manifest: submission.manifest,
        artifactIndex: artifactIndex.length ? artifactIndex : submission.artifactIndex,
      },
    };
  });

  // verifier verdict
  app.post('/api/verifier/verdict', { preHandler: (app as any).authenticateVerifier, schema: { body: verifierVerdictSchema } }, async (request: any, reply) => {
    const body = request.body as any;
    const verification = await findVerificationBySubmission(body.submissionId, body.attemptNo);
    if (!verification) return reply.code(404).send({ error: { code: 'not_found', message: 'Verification not found' } });
    if (verification.claimToken !== body.claimToken) return reply.code(401).send({ error: { code: 'invalid_claim', message: 'Claim token mismatch' } });
    if (verification.status === 'finished') {
      const submission = await getSubmission(body.submissionId);
      const job = submission ? await getJob(submission.jobId) : undefined;
      return { verificationId: verification.id, updatedJobStatus: job ?? null };
    }
    if (verification.claimExpiresAt && verification.claimExpiresAt < Date.now()) {
      return reply.code(409).send({ error: { code: 'claim_expired', message: 'Claim expired' } });
    }

    verification.status = 'finished';
    verification.verdict = body.verdict;
    verification.reason = body.reason;
    verification.scorecard = body.scorecard;
    verification.evidence = body.evidenceArtifacts;
    await updateVerification(verification);

    const submission = await getSubmission(body.submissionId);
    if (!submission) return reply.code(404).send({ error: { code: 'not_found', message: 'Submission not found' } });
    submission.finalVerdict = body.verdict;
    submission.status = body.verdict === 'pass' ? 'accepted' : body.verdict === 'fail' ? 'failed' : 'inconclusive';
    submission.finalQualityScore = body.scorecard.qualityScore;
    submission.payoutStatus = body.verdict === 'pass' ? 'pending' : 'none';
    await updateSubmission(submission);
    inc('verdict_total', 1);

    // Update reputation and dedupe registry on pass
    await recordReputation(submission.workerId, body.verdict === 'pass');
    if (body.verdict === 'pass' && submission.dedupeKey) {
      const job = await getJob(submission.jobId);
      if (job) {
        const bounty = await getBountyOrThrow(job.bountyId);
        await registerAcceptedDedupe(bounty.id, submission.dedupeKey);
      }
    }

    const job = await getJob(submission.jobId);
    if (!job) return reply.code(404).send({ error: { code: 'not_found', message: 'Job missing' } });
    job.finalVerdict = body.verdict;
    job.finalQualityScore = body.scorecard.qualityScore;

    // If inconclusive and attempts remain, requeue verification instead of completing the job.
    if (body.verdict === 'inconclusive') {
      const attempts = await db
        .selectFrom('verifications')
        .select(({ fn }) => fn.max<number>('attempt_no').as('m'))
        .where('submission_id', '=', submission.id)
        .executeTakeFirst();
      const maxAttempt = Number((attempts as any)?.m ?? 1);
      if (maxAttempt < MAX_VERIFICATION_ATTEMPTS) {
        const nextAttemptNo = maxAttempt + 1;
        const newVer: Verification = { id: nanoid(12), submissionId: submission.id, attemptNo: nextAttemptNo, status: 'queued' };
        await addVerification(newVer);
        await enqueueOutbox(
          'verification.requested',
          { verificationId: newVer.id, submissionId: submission.id, attemptNo: nextAttemptNo },
          { idempotencyKey: `verification:${submission.id}:${nextAttemptNo}` }
        );

        job.status = 'verifying';
        await updateJob(job);
        return { verificationId: verification.id, updatedJobStatus: job, requeued: true, nextAttemptNo };
      }
    }

    job.status = 'done';
    job.doneAt = Date.now();
    await updateJob(job);

    // Enqueue payout if pass
    if (body.verdict === 'pass') {
      const bounty = await getBountyOrThrow(job.bountyId);
      const payout = await addPayout(submission.id, submission.workerId, bounty.payoutCents);
      const availableAt =
        bounty.disputeWindowSec && bounty.disputeWindowSec > 0 ? new Date(Date.now() + bounty.disputeWindowSec * 1000) : undefined;
      await enqueueOutbox(
        'payout.requested',
        { payoutId: payout.id, submissionId: submission.id, workerId: submission.workerId },
        { availableAt, idempotencyKey: `payout:${payout.id}` }
      );
      inc('payout_requested_total', 1);

      // Mark artifacts accepted on pass.
      await markSubmissionArtifactsAccepted(submission.id);
    }

    return { verificationId: verification.id, updatedJobStatus: job };
  });

  // Admin endpoints
  app.post('/api/admin/workers/:workerId/ban', { preHandler: (app as any).authenticateAdmin }, async (request: any, reply) => {
    const w = await banWorker(request.params.workerId as string);
    if (!w) return reply.code(404).send({ error: { code: 'not_found', message: 'worker not found' } });
    await writeAuditEvent({
      actorType: 'admin_token',
      actorId: null,
      action: 'worker.ban',
      targetType: 'worker',
      targetId: w.id,
      metadata: {},
    });
    return { ok: true, worker: w };
  });

  app.post('/api/admin/workers/:workerId/rate-limit', { preHandler: (app as any).authenticateAdmin }, async (request: any, reply) => {
    const durationSec = Number((request.body as any)?.durationSec ?? 600);
    const w = await rateLimitWorker(request.params.workerId as string, durationSec * 1000);
    if (!w) return reply.code(404).send({ error: { code: 'not_found', message: 'worker not found' } });
    await writeAuditEvent({
      actorType: 'admin_token',
      actorId: null,
      action: 'worker.rate_limit',
      targetType: 'worker',
      targetId: w.id,
      metadata: { durationSec },
    });
    return { ok: true, worker: w };
  });

  app.post('/api/admin/verifications/:verificationId/requeue', { preHandler: (app as any).authenticateAdmin }, async (request: any, reply) => {
    const ver = await getVerification(request.params.verificationId as string);
    if (!ver) return reply.code(404).send({ error: { code: 'not_found', message: 'verification not found' } });
    ver.status = 'queued';
    ver.claimToken = undefined;
    ver.claimExpiresAt = undefined;
    await updateVerification(ver);
    await writeAuditEvent({
      actorType: 'admin_token',
      actorId: null,
      action: 'verification.requeue',
      targetType: 'verification',
      targetId: ver.id,
      metadata: { submissionId: ver.submissionId },
    });
    return { ok: true };
  });

  app.post('/api/admin/submissions/:submissionId/mark-duplicate', { preHandler: (app as any).authenticateAdmin }, async (request: any, reply) => {
    const sub = await getSubmission(request.params.submissionId as string);
    if (!sub) return reply.code(404).send({ error: { code: 'not_found', message: 'submission not found' } });
    sub.status = 'duplicate';
    sub.finalVerdict = 'fail';
    await updateSubmission(sub);
    const job = await getJob(sub.jobId);
    if (job) {
      job.status = 'done';
      job.finalVerdict = 'fail';
      await updateJob(job);
    }
    await writeAuditEvent({
      actorType: 'admin_token',
      actorId: null,
      action: 'submission.mark_duplicate',
      targetType: 'submission',
      targetId: sub.id,
      metadata: { jobId: sub.jobId },
    });
    return { ok: true };
  });

  app.post('/api/admin/submissions/:submissionId/override-verdict', { preHandler: (app as any).authenticateAdmin }, async (request: any, reply) => {
    const sub = await getSubmission(request.params.submissionId as string);
    if (!sub) return reply.code(404).send({ error: { code: 'not_found', message: 'submission not found' } });
    const { verdict, qualityScore } = request.body as any;
    if (!['pass', 'fail', 'inconclusive'].includes(verdict)) return reply.code(400).send({ error: { code: 'invalid', message: 'verdict required' } });
    sub.finalVerdict = verdict as any;
    sub.status = verdict === 'pass' ? 'accepted' : verdict === 'fail' ? 'failed' : 'inconclusive';
    sub.finalQualityScore = qualityScore ?? sub.finalQualityScore ?? 0;
    sub.payoutStatus = verdict === 'pass' ? 'pending' : 'none';
    await updateSubmission(sub);
    const job = await getJob(sub.jobId);
    if (job) {
      job.finalVerdict = verdict as any;
      job.finalQualityScore = sub.finalQualityScore;
      job.status = 'done';
      await updateJob(job);
    }
    if (verdict === 'pass') {
      if (!job) return reply.code(409).send({ error: { code: 'not_found', message: 'job missing' } });
      const bounty = await getBountyOrThrow(job.bountyId);
      const payout = await addPayout(sub.id, sub.workerId, bounty.payoutCents);
      const availableAt =
        bounty.disputeWindowSec && bounty.disputeWindowSec > 0 ? new Date(Date.now() + bounty.disputeWindowSec * 1000) : undefined;
      await enqueueOutbox(
        'payout.requested',
        { payoutId: payout.id, submissionId: sub.id, workerId: sub.workerId },
        { availableAt, idempotencyKey: `payout:${payout.id}` }
      );
      inc('payout_requested_total', 1);
      if (sub.dedupeKey && job) await registerAcceptedDedupe(job.bountyId, sub.dedupeKey);
    }
    await writeAuditEvent({
      actorType: 'admin_token',
      actorId: null,
      action: 'submission.override_verdict',
      targetType: 'submission',
      targetId: sub.id,
      metadata: { verdict, qualityScore: sub.finalQualityScore, jobId: sub.jobId },
    });
    return { ok: true, submission: sub, job };
  });

  // Payouts/disputes (admin): reconciliation + dispute resolution
  app.get('/api/admin/payouts', { preHandler: (app as any).authenticateAdmin }, async (request: any) => {
    const q = (request.query ?? {}) as any;
    const page = Math.max(1, Number(q.page ?? 1));
    const limit = Math.max(1, Math.min(200, Number(q.limit ?? 50)));
    const status = typeof q.status === 'string' ? q.status : undefined;
    const orgId = typeof q.orgId === 'string' ? q.orgId : typeof q.org_id === 'string' ? q.org_id : undefined;
    const res = await listPayoutsAdmin({ page, limit, status, orgId });
    return { payouts: res.rows, page, limit, total: res.total };
  });

  app.post('/api/admin/payouts/:payoutId/retry', { preHandler: (app as any).authenticateAdmin }, async (request: any, reply) => {
    const payoutId = String(request.params.payoutId ?? '');
    const payout = await getPayout(payoutId);
    if (!payout) return reply.code(404).send({ error: { code: 'not_found', message: 'payout not found' } });
    if (payout.status === 'paid') return reply.code(409).send({ error: { code: 'conflict', message: 'payout already paid' } });
    if (payout.status === 'refunded') return reply.code(409).send({ error: { code: 'conflict', message: 'payout refunded' } });
    if (payout.blockedReason) return reply.code(409).send({ error: { code: 'conflict', message: `payout blocked: ${payout.blockedReason}` } });

    // Reset status to pending and clear provider refs so a retry is visible and deterministic.
    await markPayoutStatus(payoutId, 'pending', { provider: null, providerRef: null });

    const nextAt = payout.holdUntil && payout.holdUntil > Date.now() ? new Date(payout.holdUntil) : new Date();
    const existingEvt = await db
      .selectFrom('outbox_events')
      .select(['id'])
      .where('topic', '=', 'payout.requested')
      .where('idempotency_key', '=', `payout:${payoutId}`)
      .executeTakeFirst();

    if (existingEvt?.id) {
      await db
        .updateTable('outbox_events')
        .set({ status: 'pending', attempts: 0, available_at: nextAt, locked_at: null, locked_by: null, last_error: null, sent_at: null })
        .where('id', '=', existingEvt.id)
        .execute();
    } else {
      await db
        .insertInto('outbox_events')
        .values({
          id: nanoid(12),
          topic: 'payout.requested',
          idempotency_key: `payout:${payoutId}`,
          payload: { payoutId, submissionId: payout.submissionId, workerId: payout.workerId },
          status: 'pending',
          attempts: 0,
          available_at: nextAt,
          locked_at: null,
          locked_by: null,
          last_error: null,
          created_at: new Date(),
          sent_at: null,
        })
        .execute();
    }

    await writeAuditEvent({
      actorType: 'admin_token',
      actorId: null,
      action: 'payout.retry',
      targetType: 'payout',
      targetId: payoutId,
      metadata: { nextAt: nextAt.toISOString() },
    });

    return { ok: true };
  });

  // Break-glass payout reconciliation: allow an admin to force payout status (paid/failed/refunded)
  // with an audit trail. This should be used rarely (e.g., provider outage / manual treasury ops).
  app.post(
    '/api/admin/payouts/:payoutId/mark',
    { preHandler: (app as any).authenticateAdmin, schema: { body: adminPayoutMarkSchema } },
    async (request: any, reply) => {
      const payoutId = String(request.params.payoutId ?? '');
      const body = request.body as any;
      const payout = await getPayout(payoutId);
      if (!payout) return reply.code(404).send({ error: { code: 'not_found', message: 'payout not found' } });

      const status = String(body.status ?? '');
      if (!['paid', 'failed', 'refunded'].includes(status)) {
        return reply.code(400).send({ error: { code: 'invalid', message: 'status must be paid|failed|refunded' } });
      }

      const provider = body.provider === null || body.provider === undefined ? 'manual' : String(body.provider);
      const providerRef = body.providerRef === null || body.providerRef === undefined ? null : String(body.providerRef);
      const reason = String(body.reason ?? '').trim();
      if (!reason) return reply.code(400).send({ error: { code: 'invalid', message: 'reason required' } });

      const now = new Date();

      await markPayoutStatus(payoutId, status as any, { provider, providerRef });

      // Stop any pending payout execution outbox event for this payout.
      await db
        .updateTable('outbox_events')
        .set({ status: 'sent', sent_at: now, locked_at: null, locked_by: null, last_error: null })
        .where('topic', '=', 'payout.requested')
        .where('idempotency_key', '=', `payout:${payoutId}`)
        .execute();

      // Best-effort mirror status into submissions.payout_status for UI/debugging.
      const subStatus =
        status === 'paid' ? 'paid' :
        status === 'failed' ? 'failed' :
        'reversed';
      await db.updateTable('submissions').set({ payout_status: subStatus }).where('id', '=', payout.submissionId).execute();

      await writeAuditEvent({
        actorType: 'admin_token',
        actorId: null,
        action: 'payout.mark_status',
        targetType: 'payout',
        targetId: payoutId,
        metadata: { status, provider, providerRef, reason },
      });

      return { ok: true };
    }
  );

  app.get('/api/admin/disputes', { preHandler: (app as any).authenticateAdmin }, async (request: any) => {
    const q = (request.query ?? {}) as any;
    const page = Math.max(1, Number(q.page ?? 1));
    const limit = Math.max(1, Math.min(200, Number(q.limit ?? 50)));
    const status = typeof q.status === 'string' ? q.status : undefined;
    const res = await listDisputesAdmin({ page, limit, status });
    return { disputes: res.rows, page, limit, total: res.total };
  });

  app.post(
    '/api/admin/disputes/:disputeId/resolve',
    { preHandler: (app as any).authenticateAdmin, schema: { body: disputeResolveSchema } },
    async (request: any, reply) => {
      const disputeId = String(request.params.disputeId ?? '');
      const body = request.body as any;
      try {
        const dispute = await resolveDisputeAdmin(
          disputeId,
          { resolution: body.resolution, notes: body.notes ?? null },
          { actorType: 'admin_token', actorId: null }
        );
        return { dispute };
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        const code = msg === 'not_found' ? 404 : msg === 'not_open' ? 409 : msg === 'payout_already_paid' ? 409 : 400;
        return reply.code(code).send({ error: { code: 'invalid', message: msg } });
      }
    }
  );

  app.post(
    '/api/admin/apps/:appId/status',
    { preHandler: (app as any).authenticateAdmin, schema: { body: adminAppStatusSchema } },
    async (request: any, reply) => {
      const appId = String(request.params.appId ?? '');
      const body = request.body as any;
      const updated = await adminSetAppStatus(appId, body.status);
      if (!updated) return reply.code(404).send({ error: { code: 'not_found', message: 'app not found' } });
      await writeAuditEvent({
        actorType: 'admin_token',
        actorId: null,
        action: 'app.set_status',
        targetType: 'app',
        targetId: appId,
        metadata: { status: body.status },
      });
      return { app: updated };
    }
  );

  // Billing ops (admin)
  app.post('/api/admin/billing/orgs/:orgId/topup', { preHandler: (app as any).authenticateAdmin }, async (request: any, reply) => {
    const orgId = request.params.orgId as string;
    const amountCents = Number((request.body as any)?.amountCents ?? 0);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return reply.code(400).send({ error: { code: 'invalid', message: 'amountCents must be > 0' } });
    }

    const now = new Date();
    await db
      .insertInto('billing_accounts')
      .values({ id: `acct_${orgId}`, org_id: orgId, balance_cents: 0, currency: 'usd', created_at: now, updated_at: now })
      .onConflict((oc) => oc.column('org_id').doNothing())
      .execute();

    const acct = await db.selectFrom('billing_accounts').selectAll().where('org_id', '=', orgId).executeTakeFirst();
    if (!acct) return reply.code(404).send({ error: { code: 'not_found', message: 'billing account not found' } });

    await db
      .updateTable('billing_accounts')
      .set({ balance_cents: sql`balance_cents + ${amountCents}`, updated_at: now })
      .where('id', '=', acct.id)
      .execute();

    await db
      .insertInto('billing_events')
      .values({
        id: nanoid(12),
        account_id: acct.id,
        event_type: 'admin_topup',
        amount_cents: amountCents,
        metadata_json: { orgId },
        created_at: now,
      })
      .execute();

    await writeAuditEvent({
      actorType: 'admin_token',
      actorId: null,
      action: 'billing.topup',
      targetType: 'billing_account',
      targetId: acct.id,
      metadata: { orgId, amountCents },
    });

    return { ok: true };
  });

  // Outbox ops
  app.get('/api/admin/outbox', { preHandler: (app as any).authenticateAdmin }, async (request: any) => {
    const q = (request.query ?? {}) as any;
    const status = typeof q.status === 'string' ? q.status : undefined;
    const topic = typeof q.topic === 'string' ? q.topic : undefined;
    const limit = Math.max(1, Math.min(200, Number(q.limit ?? 100)));

    let query = db
      .selectFrom('outbox_events')
      .select(['id', 'topic', 'status', 'attempts', 'available_at', 'locked_at', 'locked_by', 'last_error', 'created_at', 'sent_at'])
      .orderBy('created_at', 'desc')
      .limit(limit);

    if (status) query = query.where('status', '=', status);
    if (topic) query = query.where('topic', '=', topic);

    const events = await query.execute();
    return { events };
  });

  // Alarm inbox (admin): internal notification surface for CloudWatch -> SNS -> SQS deliveries.
  app.get('/api/admin/alerts', { preHandler: (app as any).authenticateAdmin }, async (request: any) => {
    const q = (request.query ?? {}) as any;
    const page = Math.max(1, Number(q.page ?? 1));
    const limit = Math.max(1, Math.min(200, Number(q.limit ?? 50)));
    const environment = typeof q.environment === 'string' ? q.environment : typeof q.env === 'string' ? q.env : undefined;
    const alarmName = typeof q.alarmName === 'string' ? q.alarmName : typeof q.alarm_name === 'string' ? q.alarm_name : undefined;

    const res = await listAlarmNotificationsAdmin({ page, limit, environment, alarmName });
    return { alerts: res.rows, page, limit, total: res.total };
  });

  // Governance: global blocked domains (admin-managed).
  app.get('/api/admin/blocked-domains', { preHandler: (app as any).authenticateAdmin }, async (request: any) => {
    const q = (request.query ?? {}) as any;
    const page = Math.max(1, Number(q.page ?? 1));
    const limit = Math.max(1, Math.min(200, Number(q.limit ?? 50)));
    const res = await listBlockedDomainsAdmin({ page, limit });
    return { blockedDomains: res.rows, page, limit, total: res.total };
  });

  app.post(
    '/api/admin/blocked-domains',
    { preHandler: (app as any).authenticateAdmin, schema: { body: blockedDomainCreateSchema } },
    async (request: any, reply) => {
      const body = request.body as any;
      try {
        const rec = await upsertBlockedDomainAdmin({ domain: body.domain, reason: body.reason ?? null });
        await writeAuditEvent({
          actorType: 'admin_token',
          actorId: null,
          action: 'blocked_domain.upsert',
          targetType: 'blocked_domain',
          targetId: rec.id,
          metadata: { domain: rec.domain },
        });
        return { blockedDomain: rec };
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        return reply.code(400).send({ error: { code: 'invalid', message: msg } });
      }
    }
  );

  app.delete('/api/admin/blocked-domains/:id', { preHandler: (app as any).authenticateAdmin }, async (request: any, reply) => {
    const id = String(request.params.id ?? '');
    const ok = await deleteBlockedDomainAdmin(id);
    if (!ok) return reply.code(404).send({ error: { code: 'not_found', message: 'blocked domain not found' } });
    await writeAuditEvent({
      actorType: 'admin_token',
      actorId: null,
      action: 'blocked_domain.delete',
      targetType: 'blocked_domain',
      targetId: id,
      metadata: {},
    });
    return { ok: true };
  });

  // Artifact quarantine/delete (admin): break-glass moderation tools.
  app.post(
    '/api/admin/artifacts/:artifactId/quarantine',
    { preHandler: (app as any).authenticateAdmin, schema: { body: adminArtifactQuarantineSchema } },
    async (request: any, reply) => {
      const artifactId = String(request.params.artifactId ?? '');
      const body = request.body as any;
      try {
        await quarantineArtifactObjectAdmin({ artifactId, reason: String(body.reason ?? '') });
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        const code = msg.includes('not_found') ? 404 : 400;
        return reply.code(code).send({ error: { code: 'invalid', message: msg } });
      }

      await writeAuditEvent({
        actorType: 'admin_token',
        actorId: null,
        action: 'artifact.quarantine',
        targetType: 'artifact',
        targetId: artifactId,
        metadata: {},
      });
      return { ok: true };
    }
  );

  app.post('/api/admin/artifacts/:artifactId/delete', { preHandler: (app as any).authenticateAdmin }, async (request: any, reply) => {
    const artifactId = String(request.params.artifactId ?? '');
    const art = await getArtifactAccessInfo(artifactId);
    if (!art || art.deletedAt) return reply.code(404).send({ error: { code: 'not_found', message: 'artifact not found' } });
    await deleteArtifactObject(artifactId);
    await writeAuditEvent({
      actorType: 'admin_token',
      actorId: null,
      action: 'artifact.delete',
      targetType: 'artifact',
      targetId: artifactId,
      metadata: {},
    });
    return { ok: true };
  });

  // Apps registry (admin): list all apps (including disabled/non-public) for moderation.
  app.get('/api/admin/apps', { preHandler: (app as any).authenticateAdmin }, async (request: any) => {
    const q = (request.query ?? {}) as any;
    const page = Math.max(1, Number(q.page ?? 1));
    const limit = Math.max(1, Math.min(200, Number(q.limit ?? 50)));
    const status = typeof q.status === 'string' && ['active', 'disabled'].includes(q.status) ? q.status : undefined;
    const ownerOrgId = typeof q.ownerOrgId === 'string' ? q.ownerOrgId : typeof q.owner_org_id === 'string' ? q.owner_org_id : undefined;
    const res = await listAllAppsAdmin({ page, limit, status, ownerOrgId });
    return { apps: res.rows, page, limit, total: res.total };
  });

  app.get('/api/admin/apps/summary', { preHandler: (app as any).authenticateAdmin }, async () => {
    return { apps: await getAppSummary(), updatedAt: new Date().toISOString() };
  });

  app.post('/api/admin/outbox/:id/requeue', { preHandler: (app as any).authenticateAdmin }, async (request: any, reply) => {
    const id = request.params.id as string;
    const updated = await db
      .updateTable('outbox_events')
      .set({
        status: 'pending',
        available_at: new Date(),
        locked_at: null,
        locked_by: null,
        last_error: null,
      })
      .where('id', '=', id)
      .returning(['id', 'topic', 'status', 'attempts'])
      .executeTakeFirst();

    if (!updated) return reply.code(404).send({ error: { code: 'not_found', message: 'outbox event not found' } });

    await writeAuditEvent({
      actorType: 'admin_token',
      actorId: null,
      action: 'outbox.requeue',
      targetType: 'outbox_event',
      targetId: id,
      metadata: { topic: updated.topic, attempts: updated.attempts },
    });

    return { ok: true, event: updated };
  });

  return app;
}

// Helpers
function envelope(state: Envelope['state'], next_steps: string[], constraints: any, submission_format: any, data: any): Envelope<any> {
  return {
    state,
    next_steps,
    constraints,
    submission_format,
    data,
  };
}

async function getBountyOrThrow(bountyId: string) {
  const bounty = await getBounty(bountyId);
  if (!bounty) throw new Error('Bounty not found');
  return bounty;
}

async function findDuplicate(bountyId: string, dedupeKey: string) {
  return await isAcceptedDuplicate(bountyId, dedupeKey);
}

if (process.env.NODE_ENV !== 'test' && import.meta.url === `file://${process.argv[1]}`) {
  const app = buildServer();
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  app.listen({ port, host: '0.0.0.0' }).then(() => {
    console.log(`Proofwork API running on :${port}`);
  });
}
