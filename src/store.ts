import { nanoid } from 'nanoid';
import { sql, type Selectable } from 'kysely';
import { db, pool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import type {
  AcceptedDedupeTable,
  BountiesTable,
  BillingAccountsTable,
  BillingEventsTable,
  BountyBudgetReservationsTable,
  JobsTable,
  OrgsTable,
  PayoutsTable,
  ReputationTable,
  SubmissionsTable,
  VerificationsTable,
  WorkersTable,
} from './db/types.js';
import { sha256 } from './utils.js';
import { normalizeOrigin, originAllowed } from './buyer.js';
import { hmacSha256Hex } from './auth/tokens.js';
import type { Bounty, Job, JobSpecResponse, Submission, Verification, Worker } from './types.js';

const TOKEN_PREFIX_LEN = 12;
const DEMO_ORG_ID = 'org_demo';
const WORKER_TOKEN_PEPPER = process.env.WORKER_TOKEN_PEPPER ?? 'dev_pepper_change_me';
if (process.env.NODE_ENV === 'production' && WORKER_TOKEN_PEPPER === 'dev_pepper_change_me') {
  throw new Error('WORKER_TOKEN_PEPPER must be set in production');
}

function ms(d: Date | null | undefined): number | undefined {
  return d ? d.getTime() : undefined;
}

function toDate(millis: number | undefined): Date | null {
  if (millis === undefined) return null;
  return new Date(millis);
}

function workerFromRow(row: Selectable<WorkersTable>): Worker {
  return {
    id: row.id,
    displayName: row.display_name ?? undefined,
    status: row.status as any,
    capabilities: (row.capabilities_json ?? {}) as Record<string, unknown>,
    rateLimitedUntil: ms(row.rate_limited_until as any),
  };
}

function bountyFromRow(row: Selectable<BountiesTable>): Bounty {
  return {
    id: row.id,
    orgId: row.org_id,
    title: row.title,
    description: row.description,
    status: row.status as any,
    allowedOrigins: (row.allowed_origins ?? []) as string[],
    journey: (row.journey_json ?? undefined) as any,
    payoutCents: row.payout_cents,
    coveragePayoutCents: row.coverage_payout_cents,
    requiredProofs: row.required_proofs,
    fingerprintClassesRequired: (row.fingerprint_classes_json ?? []) as string[],
    priority: row.priority,
    disputeWindowSec: row.dispute_window_sec,
    tags: (row.tags ?? []) as string[],
    taskDescriptor: (row.task_descriptor ?? undefined) as any,
  };
}

function jobFromRow(row: Selectable<JobsTable>): Job {
  return {
    id: row.id,
    bountyId: row.bounty_id,
    fingerprintClass: row.fingerprint_class,
    status: row.status as any,
    leaseWorkerId: row.lease_worker_id ?? undefined,
    leaseExpiresAt: ms(row.lease_expires_at as any),
    leaseNonce: row.lease_nonce ?? undefined,
    currentSubmissionId: row.current_submission_id ?? undefined,
    finalVerdict: (row.final_verdict ?? undefined) as any,
    finalQualityScore: row.final_quality_score ?? undefined,
    doneAt: ms(row.done_at as any),
    createdAt: ms(row.created_at as any),
    taskDescriptor: (row.task_descriptor ?? undefined) as any,
  };
}

function submissionFromRow(row: Selectable<SubmissionsTable>): Submission {
  return {
    id: row.id,
    jobId: row.job_id,
    workerId: row.worker_id,
    idempotencyKey: row.idempotency_key ?? undefined,
    requestHash: row.request_hash ?? undefined,
    manifest: row.manifest_json,
    artifactIndex: (row.artifact_index_json ?? []) as any[],
    status: row.status as any,
    dedupeKey: row.dedupe_key ?? undefined,
    finalVerdict: (row.final_verdict ?? undefined) as any,
    finalQualityScore: row.final_quality_score ?? undefined,
    payoutStatus: (row.payout_status ?? undefined) as any,
    createdAt: (row.created_at as any as Date).getTime(),
  };
}

function verificationFromRow(row: Selectable<VerificationsTable>): Verification {
  return {
    id: row.id,
    submissionId: row.submission_id,
    attemptNo: row.attempt_no,
    status: row.status as any,
    claimToken: row.claim_token ?? undefined,
    claimedBy: row.claimed_by ?? undefined,
    claimExpiresAt: ms(row.claim_expires_at as any),
    verdict: (row.verdict ?? undefined) as any,
    reason: row.reason ?? undefined,
    scorecard: (row.scorecard_json ?? undefined) as any,
    evidence: (row.evidence_json ?? undefined) as any,
  };
}

export async function seedDemoData() {
  // Ensure demo org exists
  await db
    .insertInto('orgs')
    .values({
      id: DEMO_ORG_ID,
      name: 'Demo Org',
      platform_fee_bps: 0,
      platform_fee_wallet_address: null,
      created_at: new Date(),
    } satisfies Selectable<OrgsTable>)
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  // Ensure demo org has a billing account with enough balance for tests/demos.
  await db
    .insertInto('billing_accounts')
    .values({
      id: `acct_${DEMO_ORG_ID}`,
      org_id: DEMO_ORG_ID,
      balance_cents: 5_000_000,
      currency: 'usd',
      created_at: new Date(),
      updated_at: new Date(),
    } satisfies Selectable<BillingAccountsTable>)
    .onConflict((oc) => oc.column('org_id').doNothing())
    .execute();

  const existing = await db.selectFrom('bounties').select(['id']).where('org_id', '=', DEMO_ORG_ID).limit(1).executeTakeFirst();
  if (existing) return;

  const bountyId = nanoid(10);
  const bounty: Bounty = {
    id: bountyId,
    orgId: DEMO_ORG_ID,
    title: 'Demo onboarding journey',
    description: 'Reach onboarding completion and capture regressions',
    allowedOrigins: ['https://example.com', 'https://app.example.com'],
    journey: {
      startUrl: 'https://example.com',
      milestones: [
        { id: 'landing', hint: 'Load landing page' },
        { id: 'cta', hint: 'Click the primary call-to-action' },
      ],
      successCondition: { type: 'url_matches', value: 'https://example.com' },
    },
    payoutCents: 1500,
    coveragePayoutCents: 200,
    requiredProofs: 3,
    fingerprintClassesRequired: ['desktop_us', 'mobile_us', 'desktop_eu'],
    priority: 0,
    disputeWindowSec: 0,
    status: 'published',
    tags: ['onboarding'],
  };

  await db
    .insertInto('bounties')
    .values({
      id: bounty.id,
      org_id: bounty.orgId,
      title: bounty.title,
      description: bounty.description,
      status: bounty.status,
      allowed_origins: JSON.stringify(bounty.allowedOrigins),
      journey_json: bounty.journey ?? {},
      task_descriptor: bounty.taskDescriptor ?? null,
      payout_cents: bounty.payoutCents,
      coverage_payout_cents: bounty.coveragePayoutCents,
      required_proofs: bounty.requiredProofs,
      fingerprint_classes_json: JSON.stringify(bounty.fingerprintClassesRequired),
      tags: JSON.stringify(bounty.tags),
      dispute_window_sec: bounty.disputeWindowSec ?? 0,
      priority: bounty.priority ?? 0,
      created_at: new Date(),
      published_at: new Date(),
    } satisfies Selectable<BountiesTable>)
    .execute();

  await db
    .insertInto('jobs')
    .values(
      bounty.fingerprintClassesRequired.map(
        (fp) =>
          ({
            id: nanoid(12),
            bounty_id: bountyId,
            fingerprint_class: fp,
      status: 'open',
            task_descriptor: bounty.taskDescriptor ?? null,
            lease_worker_id: null,
            lease_expires_at: null,
            lease_nonce: null,
            current_submission_id: null,
            final_verdict: null,
            final_quality_score: null,
            done_at: null,
            created_at: new Date(),
          } satisfies Selectable<JobsTable>)
      )
    )
    .execute();
}

export async function createWorker(
  displayName: string | undefined,
  capabilities: Record<string, unknown>
): Promise<{ worker: Worker; token: string }> {
  const id = nanoid(10);
  const token = `pw_wk_${nanoid(16)}`;
  const keyPrefix = token.slice(0, TOKEN_PREFIX_LEN);
  const keyHash = hmacSha256Hex(token, WORKER_TOKEN_PEPPER);

  await db
    .insertInto('workers')
    .values({
      id,
      display_name: displayName ?? null,
      status: 'active',
      key_prefix: keyPrefix,
      key_hash: keyHash,
      capabilities_json: capabilities ?? {},
      rate_limited_until: null,
      payout_chain: null,
      payout_address: null,
      payout_address_verified_at: null,
      payout_address_proof: null,
      created_at: new Date(),
    } satisfies Selectable<WorkersTable>)
    .execute();

  return {
    worker: { id, displayName, status: 'active', capabilities },
    token,
  };
}

export async function getWorkerByToken(token?: string): Promise<Worker | undefined> {
  if (!token) return undefined;
  const keyPrefix = token.slice(0, TOKEN_PREFIX_LEN);
  const keyHashPeppered = hmacSha256Hex(token, WORKER_TOKEN_PEPPER);
  const keyHashLegacy = sha256(token);

  const row = await db
    .selectFrom('workers')
    .selectAll()
    .where('key_prefix', '=', keyPrefix)
    .where('key_hash', 'in', [keyHashPeppered, keyHashLegacy])
    .executeTakeFirst();
  if (!row) return undefined;
  return workerFromRow(row);
}

export async function banWorker(workerId: string, _reason?: string): Promise<Worker | undefined> {
  const row = await db
    .updateTable('workers')
    .set({ status: 'banned' })
    .where('id', '=', workerId)
    .returningAll()
    .executeTakeFirst();
  return row ? workerFromRow(row) : undefined;
}

export async function rateLimitWorker(workerId: string, durationMs: number): Promise<Worker | undefined> {
  const until = new Date(Date.now() + durationMs);
  const row = await db
    .updateTable('workers')
    .set({ rate_limited_until: until })
    .where('id', '=', workerId)
    .returningAll()
    .executeTakeFirst();
  return row ? workerFromRow(row) : undefined;
}

export async function getActiveJobForWorker(workerId: string): Promise<Job | undefined> {
  const row = await db
    .selectFrom('jobs')
    .selectAll()
    .where('lease_worker_id', '=', workerId)
    .where('status', 'in', ['claimed', 'submitted', 'verifying'])
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return row ? jobFromRow(row) : undefined;
}

async function workerDuplicateRate(workerId: string, window = 100): Promise<number> {
  const res = await pool.query<{ total: string; dup: string }>(
    `
    SELECT
      count(*)::text as total,
      count(*) FILTER (WHERE status = 'duplicate')::text as dup
    FROM (
      SELECT status
      FROM submissions
      WHERE worker_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    ) s
    `,
    [workerId, window]
  );
  const row = res.rows[0];
  const total = Number(row?.total ?? 0);
  const dup = Number(row?.dup ?? 0);
  if (!total) return 0;
  return dup / total;
}

export async function findClaimableJob(
  worker: Worker,
  opts: { capabilityTag?: string; supportedCapabilityTags?: string[]; minPayoutCents?: number; taskType?: string } = {}
): Promise<{ job: Job; bounty: Bounty } | undefined> {
  const now = new Date();
  const rep = await expectedPassRate(worker.id);
  const dupRate = await workerDuplicateRate(worker.id);

  let q = db
    .selectFrom('jobs')
    .innerJoin('bounties', 'bounties.id', 'jobs.bounty_id')
    .select([
      'jobs.id as job_id',
      'jobs.bounty_id as job_bounty_id',
      'jobs.fingerprint_class as job_fingerprint_class',
      'jobs.status as job_status',
      'jobs.lease_worker_id as job_lease_worker_id',
      'jobs.lease_expires_at as job_lease_expires_at',
      'jobs.lease_nonce as job_lease_nonce',
      'jobs.current_submission_id as job_current_submission_id',
      'jobs.final_verdict as job_final_verdict',
      'jobs.final_quality_score as job_final_quality_score',
      'jobs.done_at as job_done_at',
      'jobs.task_descriptor as job_task_descriptor',
      'jobs.created_at as job_created_at',

      'bounties.id as bounty_id',
      'bounties.org_id as bounty_org_id',
      'bounties.title as bounty_title',
      'bounties.description as bounty_description',
      'bounties.status as bounty_status',
      'bounties.allowed_origins as bounty_allowed_origins',
      'bounties.journey_json as bounty_journey_json',
      'bounties.payout_cents as bounty_payout_cents',
      'bounties.coverage_payout_cents as bounty_coverage_payout_cents',
      'bounties.required_proofs as bounty_required_proofs',
      'bounties.fingerprint_classes_json as bounty_fingerprint_classes_json',
      'bounties.tags as bounty_tags',
      'bounties.dispute_window_sec as bounty_dispute_window_sec',
      'bounties.priority as bounty_priority',
      'bounties.task_descriptor as bounty_task_descriptor',
    ])
    .where('bounties.status', '=', 'published')
    .where((eb) =>
      eb.or([
        eb('jobs.status', '=', 'open'),
        eb.and([eb('jobs.status', '=', 'claimed'), eb('jobs.lease_expires_at', '<', now)]),
      ])
    )
    .orderBy('bounties.priority', 'desc')
    .orderBy('bounties.payout_cents', 'desc')
    .orderBy('jobs.created_at', 'asc')
    .limit(50);

  if (opts.taskType) {
    // When provided, restrict candidates to tasks with a matching descriptor type
    // (either on the job override or the bounty default).
    q = q.where(
      sql<string>`coalesce(jobs.task_descriptor->>'type', bounties.task_descriptor->>'type')`,
      '=',
      opts.taskType
    );
  }

  const candidates = await q.execute();

  let best: { score: number; job: Job; bounty: Bounty } | undefined;

  for (const row of candidates as any[]) {
    const job: Job = {
      id: row.job_id,
      bountyId: row.job_bounty_id,
      fingerprintClass: row.job_fingerprint_class,
      status: row.job_status,
      leaseWorkerId: row.job_lease_worker_id ?? undefined,
      leaseExpiresAt: ms(row.job_lease_expires_at),
      leaseNonce: row.job_lease_nonce ?? undefined,
      currentSubmissionId: row.job_current_submission_id ?? undefined,
      finalVerdict: row.job_final_verdict ?? undefined,
      finalQualityScore: row.job_final_quality_score ?? undefined,
      doneAt: ms(row.job_done_at),
      createdAt: ms(row.job_created_at),
      taskDescriptor: (row.job_task_descriptor ?? undefined) as any,
    };

    const bounty: Bounty = {
      id: row.bounty_id,
      orgId: row.bounty_org_id,
      title: row.bounty_title,
      description: row.bounty_description,
      status: row.bounty_status,
      allowedOrigins: (row.bounty_allowed_origins ?? []) as string[],
      journey: (row.bounty_journey_json ?? undefined) as any,
      payoutCents: row.bounty_payout_cents,
      coveragePayoutCents: row.bounty_coverage_payout_cents,
      requiredProofs: row.bounty_required_proofs,
      fingerprintClassesRequired: (row.bounty_fingerprint_classes_json ?? []) as string[],
      tags: (row.bounty_tags ?? []) as string[],
      disputeWindowSec: row.bounty_dispute_window_sec,
      priority: row.bounty_priority,
      taskDescriptor: (row.bounty_task_descriptor ?? undefined) as any,
    };

    // Re-check bounty origins remain verified (revokes should take effect).
    const originChecks = await Promise.all(bounty.allowedOrigins.map((o) => originAllowed(bounty.orgId, o)));
    if (!originChecks.every(Boolean)) continue;

    // Optional filters
    if (opts.minPayoutCents && (bounty.payoutCents ?? 0) < opts.minPayoutCents) continue;
    const descriptor = (job.taskDescriptor as any) ?? (bounty.taskDescriptor as any);
    const jobTagsRaw = Array.isArray(descriptor?.capability_tags) ? descriptor.capability_tags : [];
    // For legacy bounties/jobs with no descriptor, assume browser capability is required.
    const jobTags: string[] = jobTagsRaw.length ? jobTagsRaw.filter((t: any) => typeof t === 'string') : ['browser'];

    if (opts.capabilityTag && !jobTags.includes(opts.capabilityTag)) continue;

    if (opts.supportedCapabilityTags && opts.supportedCapabilityTags.length) {
      const supported = new Set(opts.supportedCapabilityTags.filter((t) => typeof t === 'string' && t.length));
      // Job requires a tag the worker doesn't claim to support.
      if (jobTags.some((t) => !supported.has(t))) continue;
    } else {
      // Fallback: if the worker explicitly disables browser, do not assign browser-required jobs.
      if (worker.capabilities && worker.capabilities['browser'] === false && jobTags.includes('browser')) continue;
    }

    const freshnessSlaSec = Number(descriptor?.freshness_sla_sec ?? 0);
    if (freshnessSlaSec > 0 && job.createdAt && Date.now() - job.createdAt > freshnessSlaSec * 1000) {
      // Freshness-sensitive tasks should not be claimed after the SLA window.
      continue;
    }

    // Score:
    // - priority dominates
    // - higher payout preferred
    // - low-reputation workers are biased toward lower complexity (requiredProofs)
    // - high duplicate-rate workers are penalized on high payout bounties
    const priority = bounty.priority ?? 0;
    const payout = bounty.payoutCents ?? 0;
    const complexity = bounty.requiredProofs ?? 1;

    const base = priority * 100_000 + payout;
    const complexityPenalty = complexity * (1 - rep) * 500;
    const dupPenalty = payout * dupRate * 0.2;
    const score = base - complexityPenalty - dupPenalty;

    if (!best || score > best.score) {
      best = { score, job, bounty };
    }
  }

  return best ? { job: best.job, bounty: best.bounty } : undefined;
}

export async function leaseJob(jobId: string, workerId: string, ttlMs: number): Promise<Job | undefined> {
  const leaseExpiresAt = new Date(Date.now() + ttlMs);
  const leaseNonce = nanoid(10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ensure one active job per worker (transaction-scoped advisory lock).
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), 0)', [workerId]);

    const active = await client.query(
      `
      SELECT id
      FROM jobs
      WHERE lease_worker_id = $1
        AND (
          status IN ('submitted', 'verifying')
          OR (status = 'claimed' AND (lease_expires_at IS NULL OR lease_expires_at >= now()))
        )
      LIMIT 1
      `,
      [workerId]
    );
    if ((active.rowCount ?? 0) > 0) {
      await client.query('COMMIT');
      return undefined;
    }

    const upd = await client.query(
      `
      UPDATE jobs
      SET status = 'claimed',
          lease_worker_id = $1,
          lease_expires_at = $2,
          lease_nonce = $3
      WHERE id = $4
        AND (
          status = 'open'
          OR (status = 'claimed' AND lease_expires_at < now())
        )
      RETURNING *
      `,
      [workerId, leaseExpiresAt, leaseNonce, jobId]
    );

    await client.query('COMMIT');
    if (upd.rowCount === 0) return undefined;
    return jobFromRow(upd.rows[0] as any);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getJob(jobId: string): Promise<Job | undefined> {
  const row = await db.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirst();
  return row ? jobFromRow(row) : undefined;
}

export async function getBounty(bountyId: string): Promise<Bounty | undefined> {
  const row = await db.selectFrom('bounties').selectAll().where('id', '=', bountyId).executeTakeFirst();
  return row ? bountyFromRow(row) : undefined;
}

export async function listBountiesByOrg(
  orgId: string,
  opts: { page?: number; limit?: number; status?: string; taskType?: string }
): Promise<{ rows: Bounty[]; total: number }> {
  const page = Math.max(1, Number(opts.page ?? 1));
  const limit = Math.max(1, Math.min(200, Number(opts.limit ?? 50)));
  const offset = (page - 1) * limit;

  let filtered = db.selectFrom('bounties').where('org_id', '=', orgId);
  if (opts.status) filtered = filtered.where('status', '=', opts.status);
  if (opts.taskType) {
    filtered = filtered.where(sql<string>`task_descriptor->>'type'`, '=', opts.taskType);
  }

  const rows = await filtered.selectAll().orderBy('created_at', 'desc').offset(offset).limit(limit).execute();
  const totalRow = await filtered.select(({ fn }) => fn.countAll<number>().as('c')).executeTakeFirst();

  return { rows: rows.map(bountyFromRow), total: Number(totalRow?.c ?? 0) };
}

export async function listJobsByBounty(
  bountyId: string,
  opts: { page?: number; limit?: number; status?: string }
): Promise<{ rows: Job[]; total: number }> {
  const page = Math.max(1, Number(opts.page ?? 1));
  const limit = Math.max(1, Math.min(200, Number(opts.limit ?? 50)));
  const offset = (page - 1) * limit;

  const base = db.selectFrom('jobs').where('bounty_id', '=', bountyId);
  const filtered = opts.status ? base.where('status', '=', opts.status) : base;

  const rows = await filtered.selectAll().orderBy('created_at', 'desc').offset(offset).limit(limit).execute();
  const totalRow = await filtered.select(({ fn }) => fn.countAll<number>().as('c')).executeTakeFirst();

  return { rows: rows.map(jobFromRow), total: Number(totalRow?.c ?? 0) };
}

export async function createBounty(
  input: Partial<Bounty> & { orgId: string; title: string; description: string; allowedOrigins: string[] }
): Promise<Bounty> {
  const id = nanoid(10);
  const allowedOrigins = input.allowedOrigins.map((o) => normalizeOrigin(o));
  const defaultJourney = {
    startUrl: allowedOrigins[0] ?? 'about:blank',
    milestones: [],
    successCondition: { type: 'url_matches', value: allowedOrigins[0] ?? 'about:blank' },
  };
  const bounty: Bounty = {
    id,
    orgId: input.orgId,
    title: input.title,
    description: input.description,
    allowedOrigins,
    journey: (input.journey as any) ?? (defaultJourney as any),
    payoutCents: input.payoutCents ?? 1000,
    coveragePayoutCents: input.coveragePayoutCents ?? 0,
    requiredProofs: input.requiredProofs ?? 3,
    fingerprintClassesRequired: input.fingerprintClassesRequired ?? ['desktop_us'],
    priority: input.priority ?? 0,
    disputeWindowSec: input.disputeWindowSec ?? 0,
    status: 'draft',
    tags: input.tags ?? [],
    taskDescriptor: input.taskDescriptor as any,
  };

  await db
    .insertInto('bounties')
    .values({
      id: bounty.id,
      org_id: bounty.orgId,
      title: bounty.title,
      description: bounty.description,
      status: bounty.status,
      allowed_origins: JSON.stringify(bounty.allowedOrigins),
      journey_json: bounty.journey ?? {},
      task_descriptor: bounty.taskDescriptor ?? null,
      payout_cents: bounty.payoutCents,
      coverage_payout_cents: bounty.coveragePayoutCents,
      required_proofs: bounty.requiredProofs,
      fingerprint_classes_json: JSON.stringify(bounty.fingerprintClassesRequired),
      tags: JSON.stringify(bounty.tags),
      dispute_window_sec: bounty.disputeWindowSec ?? 0,
      priority: bounty.priority ?? 0,
      created_at: new Date(),
      published_at: null,
    } satisfies Selectable<BountiesTable>)
    .execute();

  return bounty;
}

export async function publishBounty(bountyId: string): Promise<Bounty> {
  return await db.transaction().execute(async (trx) => {
    const existing = await trx.selectFrom('bounties').selectAll().where('id', '=', bountyId).executeTakeFirst();
    if (!existing) throw new Error('Bounty not found');

    // Reserve budget (idempotent per bounty).
    const fps = (existing.fingerprint_classes_json ?? []) as any;
    const jobCount = Array.isArray(fps) ? fps.length : 1;
    const reserveCents = Math.max(0, Number(existing.payout_cents ?? 0) * Math.max(1, jobCount));

    const now = new Date();

    const account =
      (await trx.selectFrom('billing_accounts').selectAll().where('org_id', '=', existing.org_id).executeTakeFirst()) ??
      (await trx
        .insertInto('billing_accounts')
        .values({
          id: `acct_${existing.org_id}`,
          org_id: existing.org_id,
          balance_cents: 0,
          currency: 'usd',
          created_at: now,
          updated_at: now,
        } satisfies Selectable<BillingAccountsTable>)
        .onConflict((oc) => oc.column('org_id').doNothing())
        .returningAll()
        .executeTakeFirst()) ??
      (await trx.selectFrom('billing_accounts').selectAll().where('org_id', '=', existing.org_id).executeTakeFirstOrThrow());

    const existingRes = await trx
      .selectFrom('bounty_budget_reservations')
      .selectAll()
      .where('bounty_id', '=', bountyId)
      .executeTakeFirst();

    if (!existingRes && reserveCents > 0) {
      const debited = await trx
        .updateTable('billing_accounts')
        .set({
          balance_cents: sql`balance_cents - ${reserveCents}`,
          updated_at: now,
        })
        .where('id', '=', account.id)
        .where('balance_cents', '>=', reserveCents)
        .returningAll()
        .executeTakeFirst();

      if (!debited) throw new Error('insufficient_funds');

      await trx
        .insertInto('billing_events')
        .values({
          id: nanoid(12),
          account_id: account.id,
          event_type: 'bounty_budget_reserve',
          amount_cents: -reserveCents,
          metadata_json: { bountyId },
          created_at: now,
        } satisfies Selectable<BillingEventsTable>)
        .execute();

      await trx
        .insertInto('bounty_budget_reservations')
        .values({
          id: nanoid(12),
          account_id: account.id,
          bounty_id: bountyId,
          amount_cents: reserveCents,
          status: 'active',
          created_at: now,
          released_at: null,
        } satisfies Selectable<BountyBudgetReservationsTable>)
        .execute();
    }

    const updated = await trx
      .updateTable('bounties')
      .set({ status: 'published', published_at: now })
      .where('id', '=', bountyId)
      .returningAll()
      .executeTakeFirstOrThrow();

    // Generate jobs for each fingerprint class (only if none exist yet)
    const existingJobs = await trx
      .selectFrom('jobs')
      .select(({ fn }) => fn.countAll<number>().as('c'))
      .where('bounty_id', '=', bountyId)
      .executeTakeFirstOrThrow();

    if (Number(existingJobs.c) === 0) {
      const fps2 = (updated.fingerprint_classes_json ?? []) as string[];
      if (fps2.length) {
        await trx
          .insertInto('jobs')
          .values(
            fps2.map(
              (fp) =>
                ({
                  id: nanoid(12),
                  bounty_id: bountyId,
                  fingerprint_class: fp,
                  status: 'open',
                  lease_worker_id: null,
                  lease_expires_at: null,
                  lease_nonce: null,
                  current_submission_id: null,
                  final_verdict: null,
                  final_quality_score: null,
                  done_at: null,
                  task_descriptor: updated.task_descriptor ?? null,
                  created_at: now,
                } satisfies Selectable<JobsTable>)
            )
          )
          .execute();
      }
    }

    return bountyFromRow(updated);
  });
}

export async function setBountyStatus(bountyId: string, status: Bounty['status']): Promise<Bounty | undefined> {
  return await db.transaction().execute(async (trx) => {
    const now = new Date();
    const row = await trx.updateTable('bounties').set({ status }).where('id', '=', bountyId).returningAll().executeTakeFirst();
    if (!row) return undefined;

    if (status === 'closed') {
      const res = await trx
        .selectFrom('bounty_budget_reservations')
        .selectAll()
        .where('bounty_id', '=', bountyId)
        .executeTakeFirst();

      if (res && res.status !== 'released') {
        const paidRow = await trx
          .selectFrom('payouts')
          .innerJoin('submissions', 'submissions.id', 'payouts.submission_id')
          .innerJoin('jobs', 'jobs.id', 'submissions.job_id')
          .select(({ fn }) => fn.coalesce(fn.sum<number>('payouts.amount_cents'), sql<number>`0`).as('s'))
          .where('jobs.bounty_id', '=', bountyId)
          .where('payouts.status', '=', 'paid')
          .executeTakeFirstOrThrow();

        const paid = Number((paidRow as any).s ?? 0);
        const remaining = Math.max(0, Number(res.amount_cents ?? 0) - paid);

        if (remaining > 0) {
          await trx
            .updateTable('billing_accounts')
            .set({
              balance_cents: sql`balance_cents + ${remaining}`,
              updated_at: now,
            })
            .where('id', '=', res.account_id)
            .execute();

          await trx
            .insertInto('billing_events')
            .values({
              id: nanoid(12),
              account_id: res.account_id,
              event_type: 'bounty_budget_release',
              amount_cents: remaining,
              metadata_json: { bountyId, paid, reserved: res.amount_cents },
              created_at: now,
            } satisfies Selectable<BillingEventsTable>)
            .execute();
        }

        await trx
          .updateTable('bounty_budget_reservations')
          .set({ status: 'released', released_at: now })
          .where('id', '=', res.id)
          .execute();
      }
    }

    return bountyFromRow(row);
  });
}

export function buildJobSpec(job: Job, bounty: Bounty): JobSpecResponse {
  const constraints = {
    allowedOrigins: bounty.allowedOrigins,
    timeBudgetSec: 240,
    maxRequestsPerMinute: 30,
    doNotDo: ['security scanning', 'exploit attempts', 'bypass access controls'],
  };
  const environment = {
    fingerprintClass: job.fingerprintClass,
    locale: job.fingerprintClass.includes('eu') ? 'en-GB' : 'en-US',
    timezone: job.fingerprintClass.includes('eu') ? 'Europe/London' : 'America/Los_Angeles',
    viewport: job.fingerprintClass.startsWith('mobile') ? { w: 390, h: 844 } : { w: 1365, h: 768 },
  };
  const journey =
    bounty.journey && typeof (bounty.journey as any)?.startUrl === 'string'
      ? (bounty.journey as any)
      : {
          startUrl: bounty.allowedOrigins[0] ?? 'about:blank',
          milestones: [],
          successCondition: { type: 'url_matches' as const, value: bounty.allowedOrigins[0] ?? 'about:blank' },
        };
  const requiredEvidence = {
    screenshots: ['landing', 'cta', 'complete', 'failure_if_any'],
    snapshotOn: ['failure_or_success'],
  };
  const submissionFormat = { manifestVersion: '1.0', requiredFiles: ['manifest.json', 'summary.md', 'repro_steps.md'] };
  const next_steps = [
    'Claim job',
    'Open startUrl and attempt milestones in order',
    'Capture required screenshots and snapshot',
    'Build manifest.json matching submissionFormat',
    'Upload artifacts via presign URLs',
    'Submit proof pack',
  ];
  return {
    jobId: job.id,
    bountyId: bounty.id,
    title: bounty.title,
    description: bounty.description,
    constraints,
    environment,
    taskDescriptor: (job.taskDescriptor as any) ?? (bounty.taskDescriptor as any),
    journey,
    requiredEvidence,
    submissionFormat,
    next_steps,
  };
}

export async function addSubmission(sub: Submission) {
  await db
    .insertInto('submissions')
    .values({
      id: sub.id,
      job_id: sub.jobId,
      worker_id: sub.workerId,
      idempotency_key: sub.idempotencyKey ?? null,
      request_hash: sub.requestHash ?? null,
      manifest_json: sub.manifest,
      artifact_index_json: JSON.stringify(sub.artifactIndex ?? []),
      status: sub.status,
      dedupe_key: sub.dedupeKey ?? null,
      final_verdict: (sub.finalVerdict as any) ?? null,
      final_quality_score: sub.finalQualityScore ?? null,
      payout_status: (sub.payoutStatus as any) ?? null,
      created_at: new Date(sub.createdAt),
    } satisfies Selectable<SubmissionsTable>)
    .execute();
}

export async function getSubmission(id: string): Promise<Submission | undefined> {
  const row = await db.selectFrom('submissions').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? submissionFromRow(row) : undefined;
}

export async function findSubmissionByIdempotency(input: {
  jobId: string;
  workerId: string;
  idempotencyKey: string;
}): Promise<Submission | undefined> {
  const row = await db
    .selectFrom('submissions')
    .selectAll()
    .where('job_id', '=', input.jobId)
    .where('worker_id', '=', input.workerId)
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst();
  return row ? submissionFromRow(row) : undefined;
}

export async function getVerification(id: string): Promise<Verification | undefined> {
  const row = await db.selectFrom('verifications').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? verificationFromRow(row) : undefined;
}

export async function addVerification(v: Verification) {
  await db
    .insertInto('verifications')
    .values({
      id: v.id,
      submission_id: v.submissionId,
      attempt_no: v.attemptNo,
      status: v.status,
      claim_token: v.claimToken ?? null,
      claimed_by: v.claimedBy ?? null,
      claim_expires_at: toDate(v.claimExpiresAt),
      verdict: (v.verdict as any) ?? null,
      reason: v.reason ?? null,
      scorecard_json: (v.scorecard as any) ?? null,
      evidence_json: v.evidence ? JSON.stringify(v.evidence) : null,
      created_at: new Date(),
    } satisfies Selectable<VerificationsTable>)
    .execute();
}

export async function findVerificationBySubmission(submissionId: string, attemptNo: number): Promise<Verification | undefined> {
  const row = await db
    .selectFrom('verifications')
    .selectAll()
    .where('submission_id', '=', submissionId)
    .where('attempt_no', '=', attemptNo)
    .executeTakeFirst();
  return row ? verificationFromRow(row) : undefined;
}

export async function listQueuedVerifications(): Promise<Verification[]> {
  const rows = await db.selectFrom('verifications').selectAll().where('status', '=', 'queued').orderBy('created_at', 'asc').execute();
  return rows.map(verificationFromRow);
}

export async function updateJob(job: Job) {
  await db
    .updateTable('jobs')
    .set({
      status: job.status,
      lease_worker_id: job.leaseWorkerId ?? null,
      lease_expires_at: toDate(job.leaseExpiresAt),
      lease_nonce: job.leaseNonce ?? null,
      current_submission_id: job.currentSubmissionId ?? null,
      final_verdict: (job.finalVerdict as any) ?? null,
      final_quality_score: job.finalQualityScore ?? null,
      done_at: toDate(job.doneAt),
    })
    .where('id', '=', job.id)
    .execute();
}

export async function updateSubmission(sub: Submission) {
  await db
    .updateTable('submissions')
    .set({
      status: sub.status,
      dedupe_key: sub.dedupeKey ?? null,
      final_verdict: (sub.finalVerdict as any) ?? null,
      final_quality_score: sub.finalQualityScore ?? null,
      payout_status: (sub.payoutStatus as any) ?? null,
      manifest_json: sub.manifest,
      artifact_index_json: JSON.stringify(sub.artifactIndex ?? []),
    })
    .where('id', '=', sub.id)
    .execute();
}

export async function updateVerification(ver: Verification) {
  await db
    .updateTable('verifications')
    .set({
      status: ver.status,
      claim_token: ver.claimToken ?? null,
      claimed_by: ver.claimedBy ?? null,
      claim_expires_at: toDate(ver.claimExpiresAt),
      verdict: (ver.verdict as any) ?? null,
      reason: ver.reason ?? null,
      scorecard_json: (ver.scorecard as any) ?? null,
      evidence_json: ver.evidence ? JSON.stringify(ver.evidence) : null,
    })
    .where('id', '=', ver.id)
    .execute();
}

export async function resetStore() {
  await runMigrations();
  await pool.query(
    [
      'TRUNCATE TABLE',
      [
        'accepted_dedupe',
        'payouts',
        'payout_transfers',
        'crypto_nonces',
        'verifications',
        'submissions',
        'jobs',
        'bounties',
        'origins',
        'org_api_keys',
        'org_users',
        'sessions',
        'disputes',
        'workers',
        'billing_events',
        'bounty_budget_reservations',
        'payment_intents',
        'stripe_webhook_events',
        'stripe_customers',
        'billing_accounts',
        'artifacts',
        'outbox_events',
        'retention_jobs',
        'retention_policies',
        'audit_log',
        'rate_limit_buckets',
        'orgs',
      ].join(', '),
      'CASCADE',
    ].join(' ')
  );
}

export async function recordReputation(workerId: string, passed: boolean) {
  const row = await db.selectFrom('reputation').selectAll().where('worker_id', '=', workerId).executeTakeFirst();
  let alpha = row?.alpha ?? 2;
  let beta = row?.beta ?? 2;
  if (passed) alpha += 1;
  else beta += 1;

  await db
    .insertInto('reputation')
    .values({ worker_id: workerId, alpha, beta, updated_at: new Date() } satisfies Selectable<ReputationTable>)
    .onConflict((oc) => oc.column('worker_id').doUpdateSet({ alpha, beta, updated_at: new Date() }))
    .execute();

  return { alpha, beta };
}

export async function expectedPassRate(workerId: string) {
  const rep = await db.selectFrom('reputation').selectAll().where('worker_id', '=', workerId).executeTakeFirst();
  if (!rep) return 0.5;
  return rep.alpha / (rep.alpha + rep.beta);
}

export async function verifierBacklog() {
  const row = await db
    .selectFrom('verifications')
    .select(({ fn }) => fn.countAll<number>().as('c'))
    .where('status', 'in', ['queued', 'in_progress'])
    .executeTakeFirstOrThrow();
  return Number(row.c);
}

export async function verifierBacklogOldestAgeSec(): Promise<number> {
  const res = await pool.query<{ age: string | null }>(
    "SELECT extract(epoch from (now() - min(created_at)))::text as age FROM verifications WHERE status IN ('queued','in_progress')"
  );
  return Number(res.rows[0]?.age ?? 0);
}

export async function outboxOldestPendingAgeSec(topic?: string): Promise<number> {
  const res = await pool.query<{ age: string | null }>(
    topic
      ? "SELECT extract(epoch from (now() - min(created_at)))::text as age FROM outbox_events WHERE status='pending' AND topic=$1"
      : "SELECT extract(epoch from (now() - min(created_at)))::text as age FROM outbox_events WHERE status='pending'",
    topic ? [topic] : []
  );
  return Number(res.rows[0]?.age ?? 0);
}

export async function artifactScanBacklogOldestAgeSec(): Promise<number> {
  const res = await pool.query<{ age: string | null }>(
    "SELECT extract(epoch from (now() - min(created_at)))::text as age FROM artifacts WHERE status='uploaded'"
  );
  return Number(res.rows[0]?.age ?? 0);
}

export async function enqueueOutbox(
  topic: string,
  payload: any,
  options?: { availableAt?: Date; idempotencyKey?: string | null }
) {
  const base = db.insertInto('outbox_events').values({
    id: nanoid(12),
    topic,
    idempotency_key: options?.idempotencyKey ?? null,
    payload,
    status: 'pending',
    attempts: 0,
    available_at: options?.availableAt ?? new Date(),
    locked_at: null,
    locked_by: null,
    last_error: null,
    created_at: new Date(),
    sent_at: null,
  });

  if (options?.idempotencyKey) {
    await base.onConflict((oc) => oc.columns(['topic', 'idempotency_key']).doNothing()).execute();
    return;
  }

  await base.execute();
}

export async function listOutbox(topic?: string) {
  let q = db.selectFrom('outbox_events').select(['id', 'topic', 'payload', 'status']).where('status', '=', 'pending');
  if (topic) q = q.where('topic', '=', topic);
  const rows = await q.orderBy('created_at', 'asc').execute();
  return rows.map((r) => ({ id: r.id, topic: r.topic, payload: r.payload, status: r.status as any }));
}

export async function getAppSummary(): Promise<
  {
    taskType: string;
    jobsTotal: number;
    jobsOpen: number;
    jobsClaimed: number;
    jobsVerifying: number;
    jobsDone: number;
    pass: number;
    fail: number;
    inconclusive: number;
    avgPayoutCents: number;
    avgCompletionSec: number | null;
    totalPaidCents: number;
    distinctWorkersPaid: number;
    avgPaidPerWorkerCents: number;
  }[]
> {
  const res = await pool.query<{
    task_type: string;
    jobs_total: string;
    jobs_open: string;
    jobs_claimed: string;
    jobs_verifying: string;
    jobs_done: string;
    pass: string;
    fail: string;
    inconclusive: string;
    avg_payout_cents: string | null;
    avg_completion_sec: string | null;
    total_paid_cents: string | null;
    distinct_workers_paid: string | null;
  }>(
    `
    WITH job_types AS (
      SELECT
        j.id AS job_id,
        COALESCE(j.task_descriptor->>'type', b.task_descriptor->>'type', 'unknown') AS task_type,
        j.status,
        j.final_verdict,
        j.created_at,
        j.done_at,
        b.payout_cents
      FROM jobs j
      JOIN bounties b ON b.id = j.bounty_id
    ),
    paid AS (
      SELECT
        s.job_id,
        p.worker_id,
        p.amount_cents,
        p.status
      FROM payouts p
      JOIN submissions s ON s.id = p.submission_id
    )
    SELECT
      jt.task_type,
      count(*)::text AS jobs_total,
      sum((jt.status = 'open')::int)::text AS jobs_open,
      sum((jt.status = 'claimed')::int)::text AS jobs_claimed,
      sum((jt.status = 'verifying')::int)::text AS jobs_verifying,
      sum((jt.status = 'done')::int)::text AS jobs_done,
      sum((jt.final_verdict = 'pass')::int)::text AS pass,
      sum((jt.final_verdict = 'fail')::int)::text AS fail,
      sum((jt.final_verdict = 'inconclusive')::int)::text AS inconclusive,
      avg(jt.payout_cents)::text AS avg_payout_cents,
      avg(extract(epoch from (jt.done_at - jt.created_at))) FILTER (WHERE jt.done_at IS NOT NULL)::text AS avg_completion_sec,
      coalesce(sum(p2.amount_cents) FILTER (WHERE p2.status = 'paid'), 0)::text AS total_paid_cents,
      count(DISTINCT p2.worker_id) FILTER (WHERE p2.status = 'paid')::text AS distinct_workers_paid
    FROM job_types jt
    LEFT JOIN paid p2 ON p2.job_id = jt.job_id
    GROUP BY jt.task_type
    ORDER BY count(*) DESC
    `
  );

  return res.rows.map((r) => {
    const totalPaid = Number(r.total_paid_cents ?? 0);
    const distinct = Number(r.distinct_workers_paid ?? 0);
    return {
      taskType: r.task_type,
      jobsTotal: Number(r.jobs_total ?? 0),
      jobsOpen: Number(r.jobs_open ?? 0),
      jobsClaimed: Number(r.jobs_claimed ?? 0),
      jobsVerifying: Number(r.jobs_verifying ?? 0),
      jobsDone: Number(r.jobs_done ?? 0),
      pass: Number(r.pass ?? 0),
      fail: Number(r.fail ?? 0),
      inconclusive: Number(r.inconclusive ?? 0),
      avgPayoutCents: Number(r.avg_payout_cents ?? 0),
      avgCompletionSec: r.avg_completion_sec ? Number(r.avg_completion_sec) : null,
      totalPaidCents: totalPaid,
      distinctWorkersPaid: distinct,
      avgPaidPerWorkerCents: distinct ? Math.round(totalPaid / distinct) : 0,
    };
  });
}

export async function markOutboxSent(id: string) {
  await db.updateTable('outbox_events').set({ status: 'sent', sent_at: new Date() }).where('id', '=', id).execute();
}

export async function addPayout(submissionId: string, workerId: string, amountCents: number) {
  const id = nanoid(12);
  const now = new Date();
  const inserted = await db
    .insertInto('payouts')
    .values({
      id,
      submission_id: submissionId,
      worker_id: workerId,
      amount_cents: amountCents,
      status: 'pending',
      provider: null,
      provider_ref: null,
      payout_chain: null,
      net_amount_cents: null,
      platform_fee_cents: null,
      platform_fee_bps: null,
      platform_fee_wallet_address: null,
      proofwork_fee_cents: null,
      proofwork_fee_bps: null,
      proofwork_fee_wallet_address: null,
      created_at: now,
      updated_at: now,
    } satisfies Selectable<PayoutsTable>)
    .onConflict((oc) => oc.column('submission_id').doNothing())
    .returningAll()
    .executeTakeFirst();

  const row =
    inserted ??
    (await db.selectFrom('payouts').selectAll().where('submission_id', '=', submissionId).executeTakeFirstOrThrow());

  return {
    id: row.id,
    submissionId: row.submission_id,
    workerId: row.worker_id,
    amountCents: row.amount_cents,
    status: row.status as any,
  };
}

export async function getPayout(id: string) {
  const row = await db.selectFrom('payouts').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) return undefined;
  return {
    id: row.id,
    submissionId: row.submission_id,
    workerId: row.worker_id,
    amountCents: row.amount_cents,
    status: row.status as any,
    provider: row.provider ?? undefined,
    providerRef: row.provider_ref ?? undefined,
  };
}

export async function markPayoutStatus(
  id: string,
  status: 'pending' | 'paid' | 'failed',
  meta?: { provider?: string | null; providerRef?: string | null }
) {
  const patch: any = { status, updated_at: new Date() };
  if (meta?.provider !== undefined) patch.provider = meta.provider;
  if (meta?.providerRef !== undefined) patch.provider_ref = meta.providerRef;

  const row = await db
    .updateTable('payouts')
    .set(patch)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
  if (!row) return;

  // Metrics (best-effort; in-process counters)
  try {
    const { inc } = await import('./metrics.js');
    if (status === 'paid') inc('payout_paid_total', 1);
    if (status === 'failed') inc('payout_failed_total', 1);
  } catch {
    // ignore
  }

  return {
    id: row.id,
    submissionId: row.submission_id,
    workerId: row.worker_id,
    amountCents: row.amount_cents,
    status: row.status as any,
    provider: row.provider ?? undefined,
    providerRef: row.provider_ref ?? undefined,
  };
}

export async function listPayouts() {
  const rows = await db.selectFrom('payouts').selectAll().orderBy('created_at', 'desc').execute();
  return rows.map((row) => ({
    id: row.id,
    submissionId: row.submission_id,
    workerId: row.worker_id,
    amountCents: row.amount_cents,
    status: row.status as any,
    provider: row.provider ?? undefined,
    providerRef: row.provider_ref ?? undefined,
  }));
}

export async function registerAcceptedDedupe(bountyId: string, key: string) {
  await db
    .insertInto('accepted_dedupe')
    .values({ bounty_id: bountyId, dedupe_key: key, accepted_at: new Date() } satisfies Selectable<AcceptedDedupeTable>)
    .onConflict((oc) => oc.columns(['bounty_id', 'dedupe_key']).doNothing())
    .execute();
}

export async function isAcceptedDuplicate(bountyId: string, key: string) {
  const row = await db
    .selectFrom('accepted_dedupe')
    .select(['bounty_id'])
    .where('bounty_id', '=', bountyId)
    .where('dedupe_key', '=', key)
    .executeTakeFirst();
  return !!row;
}

export async function reapExpiredLeases(nowMs = Date.now()) {
  const now = new Date(nowMs);
  const rows = await db
    .updateTable('jobs')
    .set({ status: 'expired', lease_worker_id: null, lease_expires_at: null, lease_nonce: null })
    .where('status', '=', 'claimed')
    .where('lease_expires_at', '<', now)
    .returning('id')
    .execute();
  return rows.map((r) => r.id);
}

export async function getOrgPlatformFeeSettings(orgId: string): Promise<
  | {
      orgId: string;
      platformFeeBps: number;
      platformFeeWalletAddress?: string;
    }
  | undefined
> {
  const row = await db
    .selectFrom('orgs')
    .select(['id', 'platform_fee_bps', 'platform_fee_wallet_address'])
    .where('id', '=', orgId)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    orgId: row.id,
    platformFeeBps: Number((row as any).platform_fee_bps ?? 0),
    platformFeeWalletAddress: row.platform_fee_wallet_address ?? undefined,
  };
}

export async function setOrgPlatformFeeSettings(
  orgId: string,
  input: { platformFeeBps: number; platformFeeWalletAddress: string | null }
): Promise<{ orgId: string; platformFeeBps: number; platformFeeWalletAddress: string | null } | undefined> {
  const row = await db
    .updateTable('orgs')
    .set({
      platform_fee_bps: input.platformFeeBps,
      platform_fee_wallet_address: input.platformFeeWalletAddress,
    })
    .where('id', '=', orgId)
    .returning(['id', 'platform_fee_bps', 'platform_fee_wallet_address'])
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    orgId: row.id,
    platformFeeBps: Number((row as any).platform_fee_bps ?? 0),
    platformFeeWalletAddress: row.platform_fee_wallet_address ?? null,
  };
}
