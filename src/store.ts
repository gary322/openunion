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
  BlockedDomainsTable,
  JobsTable,
  OrgsTable,
  AppsTable,
  DisputesTable,
  OutboxEventsTable,
  PayoutsTable,
  ReputationTable,
  SubmissionsTable,
  VerificationsTable,
  WorkersTable,
} from './db/types.js';
import { sha256 } from './utils.js';
import { normalizeOrigin, originAllowed } from './buyer.js';
import { hmacSha256Hex } from './auth/tokens.js';
import { computePayoutSplitCents, proofworkFeeBps } from './payments/crypto/baseUsdc.js';
import { assertUrlNotBlocked, normalizeBlockedDomainInput } from './security/blockedDomains.js';
import type { App, Bounty, Job, JobSpecResponse, Submission, Verification, Worker } from './types.js';

const TOKEN_PREFIX_LEN = 12;
const DEMO_ORG_ID = 'org_demo';
const WORKER_TOKEN_PEPPER = process.env.WORKER_TOKEN_PEPPER ?? 'dev_pepper_change_me';
if (process.env.NODE_ENV === 'production' && WORKER_TOKEN_PEPPER === 'dev_pepper_change_me') {
  throw new Error('WORKER_TOKEN_PEPPER must be set in production');
}

function defaultDisputeWindowSec(): number {
  const fallback = process.env.NODE_ENV === 'production' ? 86_400 : 0;
  const raw = Number(process.env.DEFAULT_DISPUTE_WINDOW_SEC ?? fallback);
  if (!Number.isFinite(raw)) return fallback;
  // Clamp to 0..30d to avoid footguns.
  return Math.max(0, Math.min(30 * 86_400, Math.floor(raw)));
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

function appFromRow(row: Selectable<AppsTable>): App {
  return {
    id: row.id,
    ownerOrgId: row.owner_org_id,
    slug: row.slug,
    taskType: row.task_type,
    name: row.name,
    description: row.description ?? undefined,
    dashboardUrl: row.dashboard_url ?? undefined,
    public: Boolean(row.public),
    status: (row.status as any) === 'disabled' ? 'disabled' : 'active',
    defaultDescriptor: ((row.default_descriptor ?? {}) as any) || {},
    uiSchema: ((row.ui_schema ?? {}) as any) || {},
    createdAt: (row.created_at as any as Date).getTime(),
    updatedAt: (row.updated_at as any as Date).getTime(),
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
      cors_allow_origins: [],
      daily_spend_limit_cents: null,
      monthly_spend_limit_cents: null,
      max_published_bounties: null,
      max_open_jobs: null,
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

export async function seedBuiltInApps() {
  const SYSTEM_ORG_ID = 'org_system';
  const now = new Date();

  // System org is the default owner for built-in app definitions.
  await db
    .insertInto('orgs')
    .values({
      id: SYSTEM_ORG_ID,
      name: 'Proofwork System',
      platform_fee_bps: 0,
      platform_fee_wallet_address: null,
      cors_allow_origins: [],
      daily_spend_limit_cents: null,
      monthly_spend_limit_cents: null,
      max_published_bounties: null,
      max_open_jobs: null,
      created_at: now,
    } satisfies Selectable<OrgsTable>)
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  const apps = [
    {
      id: 'app_clips',
      slug: 'clips',
      task_type: 'clips_highlights',
      name: 'Clips',
      description: 'VOD clipping, highlights, timestamping.',
      default_descriptor: {
        schema_version: 'v1',
        type: 'clips_highlights',
        capability_tags: ['ffmpeg', 'llm_summarize', 'screenshot'],
        input_spec: { vod_url: 'https://vod.example/test' },
        output_spec: {
          required_artifacts: [
            { kind: 'video', count: 1, label_prefix: 'clip' },
            { kind: 'other', count: 1, label_prefix: 'timeline' },
            { kind: 'log', count: 1, label_prefix: 'report' },
          ],
          mp4: true,
          json_timeline: true,
        },
        freshness_sla_sec: 3600,
      },
      ui_schema: {
        schema_version: 'v1',
        category: 'Streaming',
        bounty_defaults: { payout_cents: 1500, required_proofs: 3 },
        sections: [
          {
            id: 'inputs',
            title: 'What to clip',
            description: 'Provide a VOD and tell the worker what counts as a highlight.',
            fields: [
              {
                key: 'vod_url',
                label: 'VOD URL',
                type: 'url',
                required: true,
                placeholder: 'https://…',
                help: 'A public VOD link or a signed URL your verifier can access.',
                target: 'input_spec.vod_url',
              },
              {
                key: 'mode',
                label: 'Mode',
                type: 'select',
                required: true,
                default: 'highlights',
                options: [
                  { label: 'Highlights (best moments)', value: 'highlights' },
                  { label: 'Timestamping only (no clips)', value: 'timestamps_only' },
                ],
                target: 'input_spec.mode',
              },
              {
                key: 'rules',
                label: 'Highlight rules',
                type: 'textarea',
                required: true,
                placeholder: 'Example: pick 3 moments with peak chat excitement; 20–30s each; include 2s of lead-in.',
                help: 'Be explicit: count, duration, and what signals to look for (kills, spikes, reactions, etc.).',
                target: 'input_spec.rules',
              },
            ],
          },
          {
            id: 'constraints',
            title: 'Constraints',
            description: 'Optional constraints to keep outputs consistent and verifiable.',
            fields: [
              {
                key: 'clip_count',
                label: 'Clip count',
                type: 'number',
                required: false,
                placeholder: '3',
                help: 'How many clips you want in the final deliverable.',
                min: 1,
                max: 50,
                target: 'input_spec.clip_count',
              },
              {
                key: 'clip_duration_sec',
                label: 'Clip duration (seconds)',
                type: 'number',
                required: false,
                placeholder: '25',
                min: 5,
                max: 600,
                target: 'input_spec.clip_duration_sec',
              },
            ],
          },
        ],
        templates: [
          {
            id: 'highlights_3x25',
            name: '3 highlights (25s each)',
            preset: { mode: 'highlights', clip_count: 3, clip_duration_sec: 25, rules: 'Pick 3 moments with the biggest excitement; 25s each; include 2s lead-in.' },
          },
          {
            id: 'timestamps_only',
            name: 'Timestamping only',
            preset: { mode: 'timestamps_only', rules: 'Return a JSON timeline of noteworthy moments with short descriptions.' },
          },
        ],
      },
    },
    {
      id: 'app_marketplace',
      slug: 'marketplace',
      task_type: 'marketplace_drops',
      name: 'Marketplace',
      description: 'Price checks, drops, screenshots.',
      default_descriptor: {
        schema_version: 'v1',
        type: 'marketplace_drops',
        capability_tags: ['browser', 'screenshot'],
        input_spec: { query: 'example' },
        output_spec: {
          required_artifacts: [
            { kind: 'screenshot', count: 1 },
            { kind: 'other', count: 1, label_prefix: 'results' },
          ],
          results_json: true,
          screenshots: true,
        },
        freshness_sla_sec: 600,
      },
      ui_schema: {
        schema_version: 'v1',
        category: 'Commerce',
        bounty_defaults: { payout_cents: 1200, required_proofs: 2 },
        sections: [
          {
            id: 'query',
            title: 'What to watch',
            description: 'Describe what you want monitored or price-checked.',
            fields: [
              {
                key: 'query',
                label: 'Search query / SKU',
                type: 'text',
                required: true,
                placeholder: 'Example: “RTX 4090 FE”',
                target: 'input_spec.query',
              },
              {
                key: 'max_price_usd',
                label: 'Max price (USD)',
                type: 'number',
                required: false,
                placeholder: '1999',
                min: 0,
                max: 1_000_000,
                target: 'input_spec.max_price_usd',
              },
              {
                key: 'sites',
                label: 'Sites (optional)',
                type: 'textarea',
                required: false,
                placeholder: 'one per line (e.g., https://example.com/search?q=...)',
                help: 'If empty, the worker may use their default sources.',
                format: 'lines',
                target: 'input_spec.sites',
              },
            ],
          },
          {
            id: 'advanced',
            title: 'Advanced (optional)',
            description: 'Only fill this if you need precise DOM extraction.',
            fields: [
              {
                key: 'price_selector',
                label: 'Price selector (CSS)',
                type: 'text',
                required: false,
                placeholder: '.price',
                advanced: true,
                target: 'site_profile.price_selector',
              },
              {
                key: 'stock_selector',
                label: 'In-stock selector (CSS)',
                type: 'text',
                required: false,
                placeholder: '#add-to-cart',
                advanced: true,
                target: 'site_profile.stock_selector',
              },
            ],
          },
        ],
        templates: [
          { id: 'drops_monitor', name: 'Drop monitor', preset: { max_price_usd: 0, query: 'New release', sites: '' } },
          { id: 'price_check', name: 'Price check', preset: { query: 'Example product', max_price_usd: 999, sites: '' } },
        ],
      },
    },
    {
      id: 'app_jobs',
      slug: 'jobs',
      task_type: 'jobs_scrape',
      name: 'Jobs',
      description: 'Job scraping for a personal hunt.',
      default_descriptor: {
        schema_version: 'v1',
        type: 'jobs_scrape',
        capability_tags: ['http', 'llm_summarize', 'screenshot'],
        input_spec: { titles: ['engineer'], location: 'remote' },
        output_spec: {
          required_artifacts: [
            { kind: 'log', count: 1, label_prefix: 'report' },
            { kind: 'screenshot', count: 1 },
            { kind: 'other', count: 1, label_prefix: 'rows' },
          ],
          rows: true,
          markdown: true,
        },
        freshness_sla_sec: 86400,
      },
      ui_schema: {
        schema_version: 'v1',
        category: 'Career',
        bounty_defaults: { payout_cents: 800, required_proofs: 2 },
        sections: [
          {
            id: 'targets',
            title: 'Search targets',
            description: 'Define what jobs you want returned.',
            fields: [
              {
                key: 'titles',
                label: 'Job titles (one per line)',
                type: 'textarea',
                required: true,
                placeholder: 'Software Engineer\nMachine Learning Engineer',
                format: 'lines',
                target: 'input_spec.titles',
              },
              {
                key: 'location',
                label: 'Location',
                type: 'text',
                required: true,
                placeholder: 'Remote / NYC / Bangalore',
                target: 'input_spec.location',
              },
              {
                key: 'remote_ok',
                label: 'Remote OK',
                type: 'boolean',
                required: false,
                default: true,
                target: 'input_spec.remote_ok',
              },
            ],
          },
          {
            id: 'filters',
            title: 'Filters (optional)',
            fields: [
              { key: 'include_keywords', label: 'Include keywords', type: 'text', required: false, placeholder: 'TypeScript, LLMs', target: 'input_spec.include_keywords' },
              { key: 'exclude_keywords', label: 'Exclude keywords', type: 'text', required: false, placeholder: 'Senior, Staff', target: 'input_spec.exclude_keywords' },
            ],
          },
        ],
        templates: [
          { id: 'new_grad', name: 'New grad sweep', preset: { titles: 'New Grad Engineer\nJunior Engineer', location: 'Remote', remote_ok: true } },
          { id: 'senior_remote', name: 'Senior remote', preset: { titles: 'Senior Software Engineer', location: 'Remote', remote_ok: true } },
        ],
      },
    },
    {
      id: 'app_travel',
      slug: 'travel',
      task_type: 'travel_deals',
      name: 'Travel',
      description: 'Flights/hotels deal hunting.',
      default_descriptor: {
        schema_version: 'v1',
        type: 'travel_deals',
        capability_tags: ['http', 'llm_summarize', 'screenshot'],
        input_spec: { origin: 'SFO', dest: 'JFK' },
        output_spec: {
          required_artifacts: [
            { kind: 'log', count: 1, label_prefix: 'report' },
            { kind: 'screenshot', count: 1 },
            { kind: 'other', count: 1, label_prefix: 'deals' },
          ],
          deals: true,
          screenshots: true,
        },
        freshness_sla_sec: 1800,
      },
      ui_schema: {
        schema_version: 'v1',
        category: 'Travel',
        bounty_defaults: { payout_cents: 1000, required_proofs: 2 },
        sections: [
          {
            id: 'route',
            title: 'Trip',
            fields: [
              { key: 'origin', label: 'Origin', type: 'text', required: true, placeholder: 'SFO', target: 'input_spec.origin' },
              { key: 'dest', label: 'Destination', type: 'text', required: true, placeholder: 'JFK', target: 'input_spec.dest' },
            ],
          },
          {
            id: 'dates',
            title: 'Dates & budget (optional)',
            fields: [
              { key: 'depart_date', label: 'Depart date', type: 'date', required: false, target: 'input_spec.depart_date' },
              { key: 'return_date', label: 'Return date', type: 'date', required: false, target: 'input_spec.return_date' },
              { key: 'max_price_usd', label: 'Max price (USD)', type: 'number', required: false, placeholder: '500', min: 0, max: 1_000_000, target: 'input_spec.max_price_usd' },
            ],
          },
        ],
        templates: [
          { id: 'weekend', name: 'Weekend trip', preset: { origin: 'SFO', dest: 'LAX', max_price_usd: 250 } },
          { id: 'intl', name: 'International deal hunt', preset: { origin: 'SFO', dest: 'NRT', max_price_usd: 900 } },
        ],
      },
    },
    {
      id: 'app_research',
      slug: 'research',
      task_type: 'arxiv_research_plan',
      name: 'Research',
      description: 'ArXiv idea to research-grade plan.',
      default_descriptor: {
        schema_version: 'v1',
        type: 'arxiv_research_plan',
        capability_tags: ['http', 'llm_summarize'],
        input_spec: { idea: '' },
        output_spec: {
          required_artifacts: [
            { kind: 'log', count: 1, label_prefix: 'report' },
            { kind: 'other', count: 1, label_prefix: 'references' },
          ],
          report_md: true,
          references: true,
        },
        freshness_sla_sec: 86400,
      },
      ui_schema: {
        schema_version: 'v1',
        category: 'Research',
        bounty_defaults: { payout_cents: 2500, required_proofs: 2 },
        sections: [
          {
            id: 'idea',
            title: 'Idea',
            description: 'Describe the idea; the worker returns a research-grade plan with citations.',
            fields: [
              { key: 'idea', label: 'Idea', type: 'textarea', required: true, placeholder: 'Describe your idea in plain language…', target: 'input_spec.idea' },
              { key: 'keywords', label: 'Keywords (optional)', type: 'text', required: false, placeholder: 'LLMs, retrieval, diffusion', target: 'input_spec.keywords' },
              { key: 'min_papers', label: 'Minimum papers', type: 'number', required: false, placeholder: '15', min: 1, max: 200, target: 'input_spec.min_papers' },
            ],
          },
          {
            id: 'constraints',
            title: 'Constraints (optional)',
            fields: [
              { key: 'timeline_weeks', label: 'Timeline (weeks)', type: 'number', required: false, placeholder: '4', min: 1, max: 52, target: 'input_spec.timeline_weeks' },
              { key: 'eval_focus', label: 'Evaluation focus', type: 'text', required: false, placeholder: 'benchmarks, ablations, user study', target: 'input_spec.eval_focus' },
            ],
          },
        ],
        templates: [
          { id: 'paper_plan', name: 'Paper plan', preset: { min_papers: 20, timeline_weeks: 6 } },
          { id: 'quick_survey', name: 'Quick survey', preset: { min_papers: 10, timeline_weeks: 2 } },
        ],
      },
    },
    {
      id: 'app_github',
      slug: 'github',
      task_type: 'github_scan',
      name: 'GitHub Scan',
      description: 'Scan GitHub for similar repos/components.',
      default_descriptor: {
        schema_version: 'v1',
        type: 'github_scan',
        capability_tags: ['http', 'llm_summarize'],
        input_spec: { idea: '' },
        output_spec: {
          required_artifacts: [
            { kind: 'log', count: 1, label_prefix: 'report' },
            { kind: 'other', count: 1, label_prefix: 'repos' },
          ],
          repos: true,
          summary_md: true,
        },
        freshness_sla_sec: 86400,
      },
      ui_schema: {
        schema_version: 'v1',
        category: 'Developer tools',
        bounty_defaults: { payout_cents: 2000, required_proofs: 2 },
        sections: [
          {
            id: 'idea',
            title: 'What you want to build',
            fields: [
              { key: 'idea', label: 'Idea / problem statement', type: 'textarea', required: true, placeholder: 'Describe the product or feature…', target: 'input_spec.idea' },
              { key: 'languages', label: 'Languages (one per line)', type: 'textarea', required: false, placeholder: 'TypeScript\nPython', format: 'lines', target: 'input_spec.languages' },
              { key: 'license_allow', label: 'Allowed licenses (optional)', type: 'textarea', required: false, placeholder: 'MIT\nApache-2.0', format: 'lines', target: 'input_spec.license_allow' },
              { key: 'min_stars', label: 'Minimum stars', type: 'number', required: false, placeholder: '50', min: 0, max: 10_000_000, target: 'input_spec.min_stars' },
            ],
          },
        ],
        templates: [
          { id: 'oss_components', name: 'Find OSS components', preset: { min_stars: 50 } },
          { id: 'competitors', name: 'Find similar repos', preset: { min_stars: 10 } },
        ],
      },
    },
  ];

  for (const a of apps) {
    await db
      .insertInto('apps')
      .values({
        id: a.id,
        owner_org_id: SYSTEM_ORG_ID,
        slug: a.slug,
        task_type: a.task_type,
        name: a.name,
        description: a.description,
        dashboard_url: `/apps/${a.slug}/`,
        public: true,
        status: 'active',
        default_descriptor: a.default_descriptor ?? {},
        ui_schema: (a as any).ui_schema ?? {},
        created_at: now,
        updated_at: now,
      } satisfies Selectable<AppsTable>)
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          slug: a.slug,
          task_type: a.task_type,
          name: a.name,
          description: a.description ?? null,
          dashboard_url: `/apps/${a.slug}/`,
          public: true,
          status: 'active',
          default_descriptor: a.default_descriptor ?? {},
          ui_schema: (a as any).ui_schema ?? {},
          updated_at: now,
        })
      )
      .execute();
  }
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
  opts: { capabilityTag?: string; supportedCapabilityTags?: string[]; minPayoutCents?: number; taskType?: string; excludeJobIds?: string[] } = {}
): Promise<{ job: Job; bounty: Bounty } | undefined> {
  const now = new Date();
  const rep = await expectedPassRate(worker.id);
  const dupRate = await workerDuplicateRate(worker.id);
  const excludeSet = opts.excludeJobIds && opts.excludeJobIds.length ? new Set(opts.excludeJobIds) : null;

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

  if (opts.excludeJobIds && opts.excludeJobIds.length) {
    const uniq = Array.from(new Set(opts.excludeJobIds)).slice(0, 50);
    q = q.where('jobs.id', 'not in', uniq);
  }

  const candidates = await q.execute();

  let best: { score: number; job: Job; bounty: Bounty } | undefined;

  for (const row of candidates as any[]) {
    if (excludeSet && excludeSet.has(String(row.job_id))) continue;
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

export async function releaseJobLease(jobId: string, workerId: string, leaseNonce: string): Promise<Job | undefined> {
  const row = await db
    .updateTable('jobs')
    .set({
      status: 'open',
      lease_worker_id: null,
      lease_expires_at: null,
      lease_nonce: null,
    })
    .where('id', '=', jobId)
    .where('lease_worker_id', '=', workerId)
    .where('lease_nonce', '=', leaseNonce)
    .where('status', '=', 'claimed')
    .returningAll()
    .executeTakeFirst();
  return row ? jobFromRow(row as any) : undefined;
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
  // Defense-in-depth: allowlisted origins must not be blocked by global policy.
  await Promise.all(allowedOrigins.map((o) => assertUrlNotBlocked(o)));
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
    disputeWindowSec: input.disputeWindowSec ?? defaultDisputeWindowSec(),
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

    const orgLimits = await trx
      .selectFrom('orgs')
      .select(['daily_spend_limit_cents', 'monthly_spend_limit_cents', 'max_open_jobs'])
      .where('id', '=', existing.org_id)
      .executeTakeFirst();

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
      // Spend limits: best-effort guardrail for partner safety (in addition to balance checks).
      const dailyLimit = orgLimits?.daily_spend_limit_cents ?? null;
      if (dailyLimit !== null && dailyLimit !== undefined) {
        const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
        const row = await trx
          .selectFrom('billing_events')
          .select(({ fn }) => fn.coalesce(fn.sum<number>('amount_cents'), sql<number>`0`).as('s'))
          .where('account_id', '=', account.id)
          .where('event_type', 'in', ['bounty_budget_reserve', 'bounty_budget_release', 'dispute_refund'])
          .where('created_at', '>=', dayStart)
          .executeTakeFirstOrThrow();
        const sum = Number((row as any).s ?? 0);
        const spent = Math.max(0, -sum);
        if (spent + reserveCents > Number(dailyLimit)) throw new Error('daily_spend_limit_exceeded');
      }

      const monthlyLimit = orgLimits?.monthly_spend_limit_cents ?? null;
      if (monthlyLimit !== null && monthlyLimit !== undefined) {
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
        const row = await trx
          .selectFrom('billing_events')
          .select(({ fn }) => fn.coalesce(fn.sum<number>('amount_cents'), sql<number>`0`).as('s'))
          .where('account_id', '=', account.id)
          .where('event_type', 'in', ['bounty_budget_reserve', 'bounty_budget_release', 'dispute_refund'])
          .where('created_at', '>=', monthStart)
          .executeTakeFirstOrThrow();
        const sum = Number((row as any).s ?? 0);
        const spent = Math.max(0, -sum);
        if (spent + reserveCents > Number(monthlyLimit)) throw new Error('monthly_spend_limit_exceeded');
      }

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
        const maxOpen = orgLimits?.max_open_jobs ?? null;
        if (maxOpen !== null && maxOpen !== undefined) {
          const openRow = await trx
            .selectFrom('jobs')
            .innerJoin('bounties', 'bounties.id', 'jobs.bounty_id')
            .select(({ fn }) => fn.countAll<number>().as('c'))
            .where('bounties.org_id', '=', existing.org_id)
            .where('jobs.status', 'in', ['open', 'claimed', 'submitted', 'verifying'])
            .executeTakeFirstOrThrow();
          const openJobs = Number((openRow as any).c ?? 0);
          if (openJobs + fps2.length > Number(maxOpen)) throw new Error('max_open_jobs_exceeded');
        }

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
          // Treat any non-cancelled payout as "committed" so we don't release funds while
          // payouts are still pending/blocked/failed (or refunded minus fee).
          .where('payouts.status', 'in', ['paid', 'pending', 'failed', 'refunded'])
          .executeTakeFirstOrThrow();

        const committed = Number((paidRow as any).s ?? 0);
        const remaining = Math.max(0, Number(res.amount_cents ?? 0) - committed);

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
              metadata_json: { bountyId, committed, reserved: res.amount_cents },
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
        'apps',
        'alarm_notifications',
        'blocked_domains',
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

export async function listPublicApps(opts: { page?: number; limit?: number } = {}): Promise<{ rows: App[]; total: number }> {
  const page = Math.max(1, Number(opts.page ?? 1));
  const limit = Math.max(1, Math.min(200, Number(opts.limit ?? 50)));
  const offset = (page - 1) * limit;

  const filtered = db.selectFrom('apps').where('public', '=', true).where('status', '=', 'active');
  const rows = await filtered.selectAll().orderBy('created_at', 'desc').offset(offset).limit(limit).execute();
  const totalRow = await filtered.select(({ fn }) => fn.countAll<number>().as('c')).executeTakeFirst();
  return { rows: rows.map(appFromRow), total: Number(totalRow?.c ?? 0) };
}

export async function getPublicAppBySlug(slug: string): Promise<App | undefined> {
  const row = await db
    .selectFrom('apps')
    .selectAll()
    .where('slug', '=', slug)
    .where('public', '=', true)
    .where('status', '=', 'active')
    .executeTakeFirst();
  return row ? appFromRow(row) : undefined;
}

export async function getAppByTaskType(taskType: string): Promise<App | undefined> {
  const row = await db.selectFrom('apps').selectAll().where('task_type', '=', taskType).executeTakeFirst();
  return row ? appFromRow(row) : undefined;
}

export async function listAppsByOrg(orgId: string, opts: { page?: number; limit?: number } = {}): Promise<{ rows: App[]; total: number }> {
  const page = Math.max(1, Number(opts.page ?? 1));
  const limit = Math.max(1, Math.min(200, Number(opts.limit ?? 50)));
  const offset = (page - 1) * limit;

  const filtered = db.selectFrom('apps').where('owner_org_id', '=', orgId);
  const rows = await filtered.selectAll().orderBy('created_at', 'desc').offset(offset).limit(limit).execute();
  const totalRow = await filtered.select(({ fn }) => fn.countAll<number>().as('c')).executeTakeFirst();
  return { rows: rows.map(appFromRow), total: Number(totalRow?.c ?? 0) };
}

export async function listAllAppsAdmin(
  opts: { page?: number; limit?: number; status?: 'active' | 'disabled'; ownerOrgId?: string } = {}
): Promise<{ rows: App[]; total: number }> {
  const page = Math.max(1, Number(opts.page ?? 1));
  const limit = Math.max(1, Math.min(200, Number(opts.limit ?? 50)));
  const offset = (page - 1) * limit;

  let filtered = db.selectFrom('apps');
  if (opts.status) filtered = filtered.where('status', '=', opts.status);
  if (opts.ownerOrgId) filtered = filtered.where('owner_org_id', '=', opts.ownerOrgId);

  const rows = await filtered.selectAll().orderBy('created_at', 'desc').offset(offset).limit(limit).execute();
  const totalRow = await filtered.select(({ fn }) => fn.countAll<number>().as('c')).executeTakeFirst();
  return { rows: rows.map(appFromRow), total: Number(totalRow?.c ?? 0) };
}

export async function createOrgApp(
  orgId: string,
  input: {
    slug: string;
    taskType: string;
    name: string;
    description?: string | null;
    dashboardUrl?: string | null;
    public?: boolean;
    defaultDescriptor?: Record<string, unknown>;
    uiSchema?: Record<string, unknown>;
  }
): Promise<App> {
  const id = nanoid(12);
  const now = new Date();
  const row = await db
    .insertInto('apps')
    .values({
      id,
      owner_org_id: orgId,
      slug: input.slug,
      task_type: input.taskType,
      name: input.name,
      description: input.description ?? null,
      dashboard_url: input.dashboardUrl ?? null,
      public: input.public ?? true,
      status: 'active',
      default_descriptor: input.defaultDescriptor ?? {},
      ui_schema: input.uiSchema ?? {},
      created_at: now,
      updated_at: now,
    } satisfies Selectable<AppsTable>)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw new Error('app_create_failed');
  return appFromRow(row);
}

export async function updateOrgApp(
  orgId: string,
  appId: string,
  patch: Partial<{
    slug: string;
    taskType: string;
    name: string;
    description: string | null;
    dashboardUrl: string | null;
    public: boolean;
    status: 'active' | 'disabled';
    defaultDescriptor: Record<string, unknown>;
    uiSchema: Record<string, unknown>;
  }>
): Promise<App | undefined> {
  const now = new Date();
  const update: any = { updated_at: now };
  if (patch.slug !== undefined) update.slug = patch.slug;
  if (patch.taskType !== undefined) update.task_type = patch.taskType;
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.description !== undefined) update.description = patch.description;
  if (patch.dashboardUrl !== undefined) update.dashboard_url = patch.dashboardUrl;
  if (patch.public !== undefined) update.public = patch.public;
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.defaultDescriptor !== undefined) update.default_descriptor = patch.defaultDescriptor;
  if (patch.uiSchema !== undefined) update.ui_schema = patch.uiSchema;

  const row = await db
    .updateTable('apps')
    .set(update)
    .where('id', '=', appId)
    .where('owner_org_id', '=', orgId)
    .returningAll()
    .executeTakeFirst();
  return row ? appFromRow(row) : undefined;
}

export async function adminSetAppStatus(appId: string, status: 'active' | 'disabled'): Promise<App | undefined> {
  const row = await db
    .updateTable('apps')
    .set({ status, updated_at: new Date() })
    .where('id', '=', appId)
    .returningAll()
    .executeTakeFirst();
  return row ? appFromRow(row) : undefined;
}

export async function listBlockedDomainsAdmin(opts: { page?: number; limit?: number } = {}): Promise<{ rows: any[]; total: number }> {
  const page = Math.max(1, Number(opts.page ?? 1));
  const limit = Math.max(1, Math.min(200, Number(opts.limit ?? 50)));
  const offset = (page - 1) * limit;

  const base = db.selectFrom('blocked_domains');
  const rows = await base.selectAll().orderBy('created_at', 'desc').offset(offset).limit(limit).execute();
  const totalRow = await base.select(({ fn }) => fn.countAll<number>().as('c')).executeTakeFirst();

  const mapped = rows.map((r: any) => ({
    id: r.id,
    domain: r.domain,
    reason: r.reason ?? null,
    createdAt: (r.created_at as Date).toISOString(),
  }));
  return { rows: mapped, total: Number(totalRow?.c ?? 0) };
}

export async function upsertBlockedDomainAdmin(input: { domain: string; reason?: string | null }): Promise<any> {
  const domain = normalizeBlockedDomainInput(input.domain);
  const id = nanoid(12);
  const now = new Date();

  // Upsert by domain (case-insensitive). Postgres cannot `ON CONFLICT` on the expression index
  // we use for case-insensitive uniqueness, so handle the unique violation explicitly.
  try {
    const row = await db
      .insertInto('blocked_domains')
      .values({
        id,
        domain,
        reason: input.reason ?? null,
        created_at: now,
      } satisfies Selectable<BlockedDomainsTable>)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new Error('blocked_domain_upsert_failed');
    return { id: row.id, domain: row.domain, reason: row.reason ?? null, createdAt: (row.created_at as Date).toISOString() };
  } catch (err: any) {
    if (String(err?.code ?? '') !== '23505') throw err;
    const row = await db
      .updateTable('blocked_domains')
      .set({ reason: input.reason ?? null })
      .where(sql<boolean>`lower(domain) = lower(${domain})`)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new Error('blocked_domain_upsert_failed');
    return { id: row.id, domain: row.domain, reason: row.reason ?? null, createdAt: (row.created_at as Date).toISOString() };
  }
}

export async function deleteBlockedDomainAdmin(id: string): Promise<boolean> {
  const row = await db.deleteFrom('blocked_domains').where('id', '=', id).returning(['id']).executeTakeFirst();
  return Boolean(row?.id);
}

export async function insertAlarmNotification(input: {
  environment: string;
  topicArn: string;
  snsMessageId?: string | null;
  alarmName?: string | null;
  oldStateValue?: string | null;
  newStateValue?: string | null;
  stateReason?: string | null;
  stateChangeTime?: Date | null;
  raw: any;
}): Promise<{ id: string }> {
  const id = nanoid(12);
  const now = new Date();
  await db
    .insertInto('alarm_notifications')
    .values({
      id,
      environment: input.environment,
      topic_arn: input.topicArn,
      sns_message_id: input.snsMessageId ?? null,
      alarm_name: input.alarmName ?? null,
      old_state_value: input.oldStateValue ?? null,
      new_state_value: input.newStateValue ?? null,
      state_reason: input.stateReason ?? null,
      state_change_time: input.stateChangeTime ?? null,
      raw_json: input.raw ?? {},
      received_at: now,
    })
    .onConflict((oc) => oc.columns(['topic_arn', 'sns_message_id']).doNothing())
    .execute();
  return { id };
}

export async function listAlarmNotificationsAdmin(
  opts: { page?: number; limit?: number; environment?: string; alarmName?: string } = {}
): Promise<{ rows: any[]; total: number }> {
  const page = Math.max(1, Number(opts.page ?? 1));
  const limit = Math.max(1, Math.min(200, Number(opts.limit ?? 50)));
  const offset = (page - 1) * limit;

  // IMPORTANT: do not reuse a selectAll() query for countAll(); Postgres rejects selecting
  // non-aggregated columns alongside aggregates without GROUP BY.
  let base = db.selectFrom('alarm_notifications');
  if (opts.environment) base = base.where('environment', '=', opts.environment);
  if (opts.alarmName) base = base.where('alarm_name', '=', opts.alarmName);

  const rows = await base.selectAll().orderBy('received_at', 'desc').offset(offset).limit(limit).execute();
  const totalRow = await base.select(({ fn }) => fn.countAll<number>().as('c')).executeTakeFirst();

  const mapped = rows.map((r: any) => ({
    id: r.id,
    environment: r.environment,
    topicArn: r.topic_arn,
    snsMessageId: r.sns_message_id ?? null,
    alarmName: r.alarm_name ?? null,
    oldStateValue: r.old_state_value ?? null,
    newStateValue: r.new_state_value ?? null,
    stateReason: r.state_reason ?? null,
    stateChangeTime: r.state_change_time ? (r.state_change_time as Date).toISOString() : null,
    receivedAt: (r.received_at as Date).toISOString(),
    raw: r.raw_json ?? {},
  }));

  return { rows: mapped, total: Number(totalRow?.c ?? 0) };
}

export async function pruneAlarmNotifications(opts: { maxAgeDays: number }): Promise<{ deleted: number }> {
  const days = Number(opts.maxAgeDays);
  if (!Number.isFinite(days) || days <= 0) return { deleted: 0 };
  const cutoff = new Date(Date.now() - Math.floor(days) * 24 * 60 * 60 * 1000);
  const res = await db.deleteFrom('alarm_notifications').where('received_at', '<', cutoff).executeTakeFirst();
  return { deleted: Number((res as any)?.numDeletedRows ?? 0) };
}

export async function markOutboxSent(id: string) {
  await db.updateTable('outbox_events').set({ status: 'sent', sent_at: new Date() }).where('id', '=', id).execute();
}

export async function addPayout(submissionId: string, workerId: string, amountCents: number) {
  const id = nanoid(12);
  const now = new Date();

  // Compute hold window + fee split deterministically at creation time so:
  // - disputes can compute refunds immediately (even before payout runner executes), and
  // - dashboards can show projected splits without waiting for payment processing.
  const ctx = await db
    .selectFrom('submissions')
    .innerJoin('jobs', 'jobs.id', 'submissions.job_id')
    .innerJoin('bounties', 'bounties.id', 'jobs.bounty_id')
    .innerJoin('orgs', 'orgs.id', 'bounties.org_id')
    .select([
      'bounties.dispute_window_sec as dispute_window_sec',
      'orgs.platform_fee_bps as platform_fee_bps',
      'orgs.platform_fee_wallet_address as platform_fee_wallet_address',
    ])
    .where('submissions.id', '=', submissionId)
    .executeTakeFirst();

  const disputeWindowSec = Number((ctx as any)?.dispute_window_sec ?? 0);
  const holdUntil =
    Number.isFinite(disputeWindowSec) && disputeWindowSec > 0 ? new Date(Date.now() + disputeWindowSec * 1000) : null;

  const platformFeeBpsVal = Number((ctx as any)?.platform_fee_bps ?? 0);
  const platformFeeWalletVal = ((ctx as any)?.platform_fee_wallet_address as string | null) ?? null;
  const pwBps = proofworkFeeBps();

  const split = computePayoutSplitCents(amountCents, { platformFeeBps: platformFeeBpsVal, proofworkFeeBps: pwBps });
  const pwWalletMaybe = process.env.PROOFWORK_FEE_WALLET_BASE ?? process.env.PLATFORM_FEE_WALLET_BASE ?? null;

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
      net_amount_cents: split.netCents,
      platform_fee_cents: split.platformFeeCents,
      platform_fee_bps: platformFeeBpsVal,
      platform_fee_wallet_address: platformFeeWalletVal,
      proofwork_fee_cents: split.proofworkFeeCents,
      proofwork_fee_bps: pwBps,
      proofwork_fee_wallet_address: pwWalletMaybe,
      hold_until: holdUntil,
      blocked_reason: null,
      created_at: now,
      updated_at: now,
    } satisfies Selectable<PayoutsTable>)
    .onConflict((oc) =>
      oc.column('submission_id').doUpdateSet({
        net_amount_cents: split.netCents,
        platform_fee_cents: split.platformFeeCents,
        platform_fee_bps: platformFeeBpsVal,
        platform_fee_wallet_address: platformFeeWalletVal,
        proofwork_fee_cents: split.proofworkFeeCents,
        proofwork_fee_bps: pwBps,
        proofwork_fee_wallet_address: pwWalletMaybe,
        hold_until: holdUntil,
        updated_at: now,
      })
    )
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
    payoutChain: row.payout_chain ?? undefined,
    netAmountCents: row.net_amount_cents ?? undefined,
    platformFeeCents: row.platform_fee_cents ?? undefined,
    platformFeeBps: row.platform_fee_bps ?? undefined,
    platformFeeWalletAddress: row.platform_fee_wallet_address ?? undefined,
    proofworkFeeCents: row.proofwork_fee_cents ?? undefined,
    proofworkFeeBps: row.proofwork_fee_bps ?? undefined,
    proofworkFeeWalletAddress: row.proofwork_fee_wallet_address ?? undefined,
    holdUntil: ms(row.hold_until as any),
    blockedReason: row.blocked_reason ?? undefined,
    createdAt: ms(row.created_at as any),
    updatedAt: ms(row.updated_at as any),
  };
}

export async function markPayoutStatus(
  id: string,
  status: 'pending' | 'paid' | 'failed' | 'refunded',
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

function payoutViewFromJoinedRow(row: any) {
  return {
    id: row.payout_id,
    orgId: row.org_id,
    bountyId: row.bounty_id,
    bountyTitle: row.bounty_title,
    jobId: row.job_id,
    submissionId: row.submission_id,
    workerId: row.worker_id,
    workerDisplayName: row.worker_display_name ?? undefined,
    taskType: row.task_type ?? null,
    amountCents: Number(row.amount_cents ?? 0),
    netAmountCents: row.net_amount_cents !== null && row.net_amount_cents !== undefined ? Number(row.net_amount_cents) : null,
    platformFeeCents: row.platform_fee_cents !== null && row.platform_fee_cents !== undefined ? Number(row.platform_fee_cents) : null,
    platformFeeBps: row.platform_fee_bps !== null && row.platform_fee_bps !== undefined ? Number(row.platform_fee_bps) : null,
    platformFeeWalletAddress: row.platform_fee_wallet_address ?? null,
    proofworkFeeCents: row.proofwork_fee_cents !== null && row.proofwork_fee_cents !== undefined ? Number(row.proofwork_fee_cents) : null,
    proofworkFeeBps: row.proofwork_fee_bps !== null && row.proofwork_fee_bps !== undefined ? Number(row.proofwork_fee_bps) : null,
    proofworkFeeWalletAddress: row.proofwork_fee_wallet_address ?? null,
    status: row.status,
    provider: row.provider ?? null,
    providerRef: row.provider_ref ?? null,
    payoutChain: row.payout_chain ?? null,
    holdUntil: row.hold_until ? (row.hold_until as Date).getTime() : null,
    blockedReason: row.blocked_reason ?? null,
    createdAt: row.created_at ? (row.created_at as Date).getTime() : null,
    updatedAt: row.updated_at ? (row.updated_at as Date).getTime() : null,
  };
}

export async function listPayoutsByOrg(
  orgId: string,
  opts: { page?: number; limit?: number; status?: string; taskType?: string } = {}
): Promise<{ rows: any[]; total: number }> {
  const page = Math.max(1, Number(opts.page ?? 1));
  const limit = Math.max(1, Math.min(200, Number(opts.limit ?? 50)));
  const offset = (page - 1) * limit;

  let base = db
    .selectFrom('payouts as p')
    .innerJoin('submissions as s', 's.id', 'p.submission_id')
    .innerJoin('jobs as j', 'j.id', 's.job_id')
    .innerJoin('bounties as b', 'b.id', 'j.bounty_id')
    .leftJoin('workers as w', 'w.id', 'p.worker_id')
    .where('b.org_id', '=', orgId);

  if (opts.status) base = base.where('p.status', '=', opts.status);
  if (opts.taskType) base = base.where(sql<string>`j.task_descriptor->>'type'`, '=', opts.taskType);

  const rows = await base
    .select([
      'p.id as payout_id',
      'p.submission_id as submission_id',
      'p.worker_id as worker_id',
      'w.display_name as worker_display_name',
      'p.amount_cents as amount_cents',
      'p.status as status',
      'p.provider as provider',
      'p.provider_ref as provider_ref',
      'p.net_amount_cents as net_amount_cents',
      'p.platform_fee_cents as platform_fee_cents',
      'p.platform_fee_bps as platform_fee_bps',
      'p.platform_fee_wallet_address as platform_fee_wallet_address',
      'p.proofwork_fee_cents as proofwork_fee_cents',
      'p.proofwork_fee_bps as proofwork_fee_bps',
      'p.proofwork_fee_wallet_address as proofwork_fee_wallet_address',
      'p.payout_chain as payout_chain',
      'p.hold_until as hold_until',
      'p.blocked_reason as blocked_reason',
      'p.created_at as created_at',
      'p.updated_at as updated_at',
      'b.id as bounty_id',
      'b.title as bounty_title',
      'b.org_id as org_id',
      'j.id as job_id',
      sql<string>`j.task_descriptor->>'type'`.as('task_type'),
    ])
    .orderBy('p.created_at', 'desc')
    .offset(offset)
    .limit(limit)
    .execute();

  const totalRow = await base.select(({ fn }) => fn.countAll<number>().as('c')).executeTakeFirst();

  return { rows: rows.map(payoutViewFromJoinedRow), total: Number(totalRow?.c ?? 0) };
}

export async function listPayoutsByWorker(
  workerId: string,
  opts: { page?: number; limit?: number; status?: string } = {}
): Promise<{ rows: any[]; total: number }> {
  const page = Math.max(1, Number(opts.page ?? 1));
  const limit = Math.max(1, Math.min(200, Number(opts.limit ?? 50)));
  const offset = (page - 1) * limit;

  let base = db
    .selectFrom('payouts as p')
    .innerJoin('submissions as s', 's.id', 'p.submission_id')
    .innerJoin('jobs as j', 'j.id', 's.job_id')
    .innerJoin('bounties as b', 'b.id', 'j.bounty_id')
    .where('p.worker_id', '=', workerId);

  if (opts.status) base = base.where('p.status', '=', opts.status);

  const rows = await base
    .select([
      'p.id as payout_id',
      'p.submission_id as submission_id',
      'p.worker_id as worker_id',
      'p.amount_cents as amount_cents',
      'p.status as status',
      'p.provider as provider',
      'p.provider_ref as provider_ref',
      'p.net_amount_cents as net_amount_cents',
      'p.platform_fee_cents as platform_fee_cents',
      'p.platform_fee_bps as platform_fee_bps',
      'p.platform_fee_wallet_address as platform_fee_wallet_address',
      'p.proofwork_fee_cents as proofwork_fee_cents',
      'p.proofwork_fee_bps as proofwork_fee_bps',
      'p.proofwork_fee_wallet_address as proofwork_fee_wallet_address',
      'p.payout_chain as payout_chain',
      'p.hold_until as hold_until',
      'p.blocked_reason as blocked_reason',
      'p.created_at as created_at',
      'p.updated_at as updated_at',
      'b.id as bounty_id',
      'b.title as bounty_title',
      'b.org_id as org_id',
      'j.id as job_id',
      sql<string>`j.task_descriptor->>'type'`.as('task_type'),
    ])
    .orderBy('p.created_at', 'desc')
    .offset(offset)
    .limit(limit)
    .execute();

  const totalRow = await base.select(({ fn }) => fn.countAll<number>().as('c')).executeTakeFirst();
  return { rows: rows.map(payoutViewFromJoinedRow), total: Number(totalRow?.c ?? 0) };
}

export async function listPayoutsAdmin(
  opts: { page?: number; limit?: number; status?: string; orgId?: string } = {}
): Promise<{ rows: any[]; total: number }> {
  const page = Math.max(1, Number(opts.page ?? 1));
  const limit = Math.max(1, Math.min(200, Number(opts.limit ?? 50)));
  const offset = (page - 1) * limit;

  let base = db
    .selectFrom('payouts as p')
    .innerJoin('submissions as s', 's.id', 'p.submission_id')
    .innerJoin('jobs as j', 'j.id', 's.job_id')
    .innerJoin('bounties as b', 'b.id', 'j.bounty_id')
    .leftJoin('workers as w', 'w.id', 'p.worker_id');

  if (opts.orgId) base = base.where('b.org_id', '=', opts.orgId);
  if (opts.status) base = base.where('p.status', '=', opts.status);

  const rows = await base
    .select([
      'p.id as payout_id',
      'p.submission_id as submission_id',
      'p.worker_id as worker_id',
      'w.display_name as worker_display_name',
      'p.amount_cents as amount_cents',
      'p.status as status',
      'p.provider as provider',
      'p.provider_ref as provider_ref',
      'p.net_amount_cents as net_amount_cents',
      'p.platform_fee_cents as platform_fee_cents',
      'p.platform_fee_bps as platform_fee_bps',
      'p.platform_fee_wallet_address as platform_fee_wallet_address',
      'p.proofwork_fee_cents as proofwork_fee_cents',
      'p.proofwork_fee_bps as proofwork_fee_bps',
      'p.proofwork_fee_wallet_address as proofwork_fee_wallet_address',
      'p.payout_chain as payout_chain',
      'p.hold_until as hold_until',
      'p.blocked_reason as blocked_reason',
      'p.created_at as created_at',
      'p.updated_at as updated_at',
      'b.id as bounty_id',
      'b.title as bounty_title',
      'b.org_id as org_id',
      'j.id as job_id',
      sql<string>`j.task_descriptor->>'type'`.as('task_type'),
    ])
    .orderBy('p.created_at', 'desc')
    .offset(offset)
    .limit(limit)
    .execute();

  const totalRow = await base.select(({ fn }) => fn.countAll<number>().as('c')).executeTakeFirst();
  return { rows: rows.map(payoutViewFromJoinedRow), total: Number(totalRow?.c ?? 0) };
}

export async function getOrgEarningsSummary(orgId: string): Promise<any> {
  const res = await pool.query(
    `
    WITH payouts_ctx AS (
      SELECT
        p.*,
        (j.task_descriptor->>'type') AS task_type
      FROM payouts p
      JOIN submissions s ON s.id = p.submission_id
      JOIN jobs j ON j.id = s.job_id
      JOIN bounties b ON b.id = j.bounty_id
      WHERE b.org_id = $1
    )
    SELECT
      count(*) FILTER (WHERE status = 'paid')::int AS paid_count,
      coalesce(sum(amount_cents) FILTER (WHERE status = 'paid'), 0)::int AS gross_paid_cents,
      coalesce(sum(net_amount_cents) FILTER (WHERE status = 'paid'), 0)::int AS net_paid_cents,
      coalesce(sum(platform_fee_cents) FILTER (WHERE status = 'paid'), 0)::int AS platform_fee_cents,
      coalesce(sum(proofwork_fee_cents) FILTER (WHERE status = 'paid'), 0)::int AS proofwork_fee_cents,
      count(*) FILTER (WHERE status = 'pending')::int AS pending_count,
      count(*) FILTER (WHERE status = 'failed')::int AS failed_count,
      count(*) FILTER (WHERE status = 'refunded')::int AS refunded_count
    FROM payouts_ctx
    `,
    [orgId]
  );
  const totals = res.rows[0] ?? {};

  const byTask = await pool.query(
    `
    WITH payouts_ctx AS (
      SELECT
        p.*,
        (j.task_descriptor->>'type') AS task_type
      FROM payouts p
      JOIN submissions s ON s.id = p.submission_id
      JOIN jobs j ON j.id = s.job_id
      JOIN bounties b ON b.id = j.bounty_id
      WHERE b.org_id = $1
    )
    SELECT
      task_type,
      count(*) FILTER (WHERE status = 'paid')::int AS paid_count,
      coalesce(sum(amount_cents) FILTER (WHERE status = 'paid'), 0)::int AS gross_paid_cents,
      coalesce(sum(net_amount_cents) FILTER (WHERE status = 'paid'), 0)::int AS net_paid_cents,
      coalesce(sum(platform_fee_cents) FILTER (WHERE status = 'paid'), 0)::int AS platform_fee_cents,
      coalesce(sum(proofwork_fee_cents) FILTER (WHERE status = 'paid'), 0)::int AS proofwork_fee_cents
    FROM payouts_ctx
    GROUP BY task_type
    ORDER BY coalesce(sum(amount_cents) FILTER (WHERE status = 'paid'), 0) DESC
    `,
    [orgId]
  );

  return {
    orgId,
    totals: {
      paidCount: Number(totals.paid_count ?? 0),
      grossPaidCents: Number(totals.gross_paid_cents ?? 0),
      netPaidCents: Number(totals.net_paid_cents ?? 0),
      platformFeeCents: Number(totals.platform_fee_cents ?? 0),
      proofworkFeeCents: Number(totals.proofwork_fee_cents ?? 0),
      pendingCount: Number(totals.pending_count ?? 0),
      failedCount: Number(totals.failed_count ?? 0),
      refundedCount: Number(totals.refunded_count ?? 0),
    },
    byTaskType: (byTask.rows ?? []).map((r: any) => ({
      taskType: r.task_type ?? null,
      paidCount: Number(r.paid_count ?? 0),
      grossPaidCents: Number(r.gross_paid_cents ?? 0),
      netPaidCents: Number(r.net_paid_cents ?? 0),
      platformFeeCents: Number(r.platform_fee_cents ?? 0),
      proofworkFeeCents: Number(r.proofwork_fee_cents ?? 0),
    })),
  };
}

function disputeFromRow(row: any) {
  return {
    id: row.id,
    orgId: row.org_id,
    bountyId: row.bounty_id,
    submissionId: row.submission_id ?? null,
    payoutId: row.payout_id ?? null,
    status: row.status,
    reason: row.reason ?? null,
    resolution: row.resolution ?? null,
    resolutionNotes: row.resolution_notes ?? null,
    createdAt: row.created_at ? (row.created_at as Date).getTime() : null,
    resolvedAt: row.resolved_at ? (row.resolved_at as Date).getTime() : null,
    resolverActorType: row.resolver_actor_type ?? null,
    resolverActorId: row.resolver_actor_id ?? null,
  };
}

export async function listDisputesByOrg(
  orgId: string,
  opts: { page?: number; limit?: number; status?: string } = {}
): Promise<{ rows: any[]; total: number }> {
  const page = Math.max(1, Number(opts.page ?? 1));
  const limit = Math.max(1, Math.min(200, Number(opts.limit ?? 50)));
  const offset = (page - 1) * limit;

  // IMPORTANT: keep the count query aggregate-only (no `selectAll`) to avoid invalid SQL.
  let q = db.selectFrom('disputes').where('org_id', '=', orgId);
  if (opts.status) q = q.where('status', '=', opts.status);
  const rows = await q.selectAll().orderBy('created_at', 'desc').offset(offset).limit(limit).execute();
  const totalRow = await q.select(({ fn }) => fn.countAll<number>().as('c')).executeTakeFirst();
  return { rows: rows.map(disputeFromRow), total: Number(totalRow?.c ?? 0) };
}

export async function listDisputesAdmin(
  opts: { page?: number; limit?: number; status?: string } = {}
): Promise<{ rows: any[]; total: number }> {
  const page = Math.max(1, Number(opts.page ?? 1));
  const limit = Math.max(1, Math.min(200, Number(opts.limit ?? 50)));
  const offset = (page - 1) * limit;

  // IMPORTANT: keep the count query aggregate-only (no `selectAll`) to avoid invalid SQL.
  let q = db.selectFrom('disputes');
  if (opts.status) q = q.where('status', '=', opts.status);
  const rows = await q.selectAll().orderBy('created_at', 'desc').offset(offset).limit(limit).execute();
  const totalRow = await q.select(({ fn }) => fn.countAll<number>().as('c')).executeTakeFirst();
  return { rows: rows.map(disputeFromRow), total: Number(totalRow?.c ?? 0) };
}

export async function createDispute(
  orgId: string,
  input: { payoutId?: string; submissionId?: string; reason: string },
  actor: { actorType: string; actorId: string | null }
): Promise<any> {
  const payoutId = input.payoutId ? String(input.payoutId) : null;
  const submissionId = input.submissionId ? String(input.submissionId) : null;
  if (!payoutId && !submissionId) throw new Error('missing_target');

  return await db.transaction().execute(async (trx) => {
    const now = new Date();

    // Resolve bounty/submission/payout and enforce org ownership.
    const ctx = payoutId
      ? await trx
          .selectFrom('payouts as p')
          .innerJoin('submissions as s', 's.id', 'p.submission_id')
          .innerJoin('jobs as j', 'j.id', 's.job_id')
          .innerJoin('bounties as b', 'b.id', 'j.bounty_id')
          .select([
            'b.org_id as org_id',
            'b.id as bounty_id',
            's.id as submission_id',
            'p.id as payout_id',
            'p.status as payout_status',
            'p.hold_until as hold_until',
            'p.worker_id as worker_id',
          ])
          .where('p.id', '=', payoutId)
          .executeTakeFirst()
      : await trx
          .selectFrom('submissions as s')
          .innerJoin('jobs as j', 'j.id', 's.job_id')
          .innerJoin('bounties as b', 'b.id', 'j.bounty_id')
          .leftJoin('payouts as p', 'p.submission_id', 's.id')
          .select([
            'b.org_id as org_id',
            'b.id as bounty_id',
            's.id as submission_id',
            'p.id as payout_id',
            'p.status as payout_status',
            'p.hold_until as hold_until',
            'p.worker_id as worker_id',
          ])
          .where('s.id', '=', submissionId!)
          .executeTakeFirst();

    if (!ctx) throw new Error('target_not_found');
    if (String((ctx as any).org_id) !== orgId) throw new Error('forbidden');

    const payoutStatus = String((ctx as any).payout_status ?? '');
    if (payoutStatus === 'paid') throw new Error('payout_already_paid');

    const finalPayoutId = ((ctx as any).payout_id as string | null) ?? null;
    if (!finalPayoutId) throw new Error('payout_missing');

    const holdUntil = ((ctx as any).hold_until as Date | null) ?? null;
    if (!holdUntil) throw new Error('dispute_window_disabled');
    if (holdUntil.getTime() <= Date.now()) throw new Error('dispute_window_expired');

    const open = await trx
      .selectFrom('disputes')
      .select(['id'])
      .where('payout_id', '=', finalPayoutId)
      .where('status', '=', 'open')
      .executeTakeFirst();
    if (open) throw new Error('dispute_already_open');

    const id = nanoid(12);
    const row = await trx
      .insertInto('disputes')
      .values({
        id,
        org_id: orgId,
        bounty_id: (ctx as any).bounty_id,
        submission_id: (ctx as any).submission_id ?? null,
        payout_id: finalPayoutId,
        status: 'open',
        reason: input.reason ?? null,
        resolution: null,
        resolution_notes: null,
        created_at: now,
        resolved_at: null,
        resolver_actor_type: null,
        resolver_actor_id: null,
      } satisfies Selectable<DisputesTable>)
      .returningAll()
      .executeTakeFirstOrThrow();

    // Block payout and stop any pending payout execution until the dispute is resolved.
    await trx.updateTable('payouts').set({ blocked_reason: 'dispute_open', updated_at: now }).where('id', '=', finalPayoutId).execute();

    // Mark payout.requested outbox event as sent so it won't fire while the dispute is open.
    await trx
      .updateTable('outbox_events')
      .set({ status: 'sent', sent_at: now, locked_at: null, locked_by: null, last_error: null })
      .where('topic', '=', 'payout.requested')
      .where('idempotency_key', '=', `payout:${finalPayoutId}`)
      .execute();

    // Schedule an automatic refund at hold_until (refund = gross - Proofwork fee).
    await trx
      .insertInto('outbox_events')
      .values({
        id: nanoid(12),
        topic: 'dispute.auto_refund.requested',
        idempotency_key: `dispute:auto_refund:${id}`,
        payload: { disputeId: id },
        status: 'pending',
        attempts: 0,
        available_at: holdUntil,
        locked_at: null,
        locked_by: null,
        last_error: null,
        created_at: now,
        sent_at: null,
      } satisfies Selectable<OutboxEventsTable>)
      .onConflict((oc) => oc.columns(['topic', 'idempotency_key']).doNothing())
      .execute();

    await trx
      .insertInto('audit_log')
      .values({
        id: nanoid(12),
        actor_type: actor.actorType,
        actor_id: actor.actorId,
        action: 'dispute.open',
        target_type: 'dispute',
        target_id: id,
        metadata: { payoutId: finalPayoutId, submissionId: (ctx as any).submission_id, holdUntil: holdUntil.toISOString() },
        created_at: now,
      })
      .execute();

    return disputeFromRow(row);
  });
}

export async function cancelDispute(orgId: string, disputeId: string, actor: { actorType: string; actorId: string | null }): Promise<any> {
  return await db.transaction().execute(async (trx) => {
    const now = new Date();
    const row = await trx
      .selectFrom('disputes')
      .selectAll()
      .where('id', '=', disputeId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new Error('not_found');
    if (row.org_id !== orgId) throw new Error('forbidden');
    if (row.status !== 'open') throw new Error('not_open');

    const updated = await trx
      .updateTable('disputes')
      .set({
        status: 'cancelled',
        resolved_at: now,
        resolver_actor_type: actor.actorType,
        resolver_actor_id: actor.actorId,
        resolution: 'cancelled',
        resolution_notes: null,
      })
      .where('id', '=', disputeId)
      .returningAll()
      .executeTakeFirstOrThrow();

    if (row.payout_id) {
      await trx.updateTable('payouts').set({ blocked_reason: null, updated_at: now }).where('id', '=', row.payout_id).execute();

      const payoutRow = await trx
        .selectFrom('payouts')
        .select(['hold_until', 'submission_id', 'worker_id'])
        .where('id', '=', row.payout_id)
        .executeTakeFirstOrThrow();

      const nextAt =
        payoutRow.hold_until && (payoutRow.hold_until as any as Date).getTime() > Date.now() ? payoutRow.hold_until : now;

      const existingEvt = await trx
        .selectFrom('outbox_events')
        .select(['id'])
        .where('topic', '=', 'payout.requested')
        .where('idempotency_key', '=', `payout:${row.payout_id}`)
        .executeTakeFirst();

      if (existingEvt?.id) {
        await trx
          .updateTable('outbox_events')
          .set({ status: 'pending', available_at: nextAt, locked_at: null, locked_by: null, last_error: null, sent_at: null })
          .where('id', '=', existingEvt.id)
          .execute();
      } else {
        await trx
          .insertInto('outbox_events')
          .values({
            id: nanoid(12),
            topic: 'payout.requested',
            idempotency_key: `payout:${row.payout_id}`,
            payload: { payoutId: row.payout_id, submissionId: payoutRow.submission_id, workerId: payoutRow.worker_id },
            status: 'pending',
            attempts: 0,
            available_at: nextAt,
            locked_at: null,
            locked_by: null,
            last_error: null,
            created_at: now,
            sent_at: null,
          } satisfies Selectable<OutboxEventsTable>)
          .execute();
      }
    }

    await trx
      .insertInto('audit_log')
      .values({
        id: nanoid(12),
        actor_type: actor.actorType,
        actor_id: actor.actorId,
        action: 'dispute.cancel',
        target_type: 'dispute',
        target_id: disputeId,
        metadata: {},
        created_at: now,
      })
      .execute();

    return disputeFromRow(updated);
  });
}

export async function resolveDisputeAdmin(
  disputeId: string,
  input: { resolution: 'refund' | 'uphold'; notes?: string | null },
  actor: { actorType: string; actorId: string | null }
): Promise<any> {
  return await db.transaction().execute(async (trx) => {
    const now = new Date();
    const row = await trx
      .selectFrom('disputes')
      .selectAll()
      .where('id', '=', disputeId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new Error('not_found');
    if (row.status !== 'open') throw new Error('not_open');

    const payoutId = row.payout_id;
    if (!payoutId) throw new Error('payout_missing');

    const payoutRow = await trx.selectFrom('payouts').selectAll().where('id', '=', payoutId).forUpdate().executeTakeFirstOrThrow();
    if (payoutRow.status === 'paid') throw new Error('payout_already_paid');
    if (payoutRow.status === 'refunded') return disputeFromRow(row);

    if (input.resolution === 'refund') {
      const proofworkFee = Number(payoutRow.proofwork_fee_cents ?? 0);
      const refundCents = Math.max(0, Number(payoutRow.amount_cents ?? 0) - (Number.isFinite(proofworkFee) ? proofworkFee : 0));

      // Credit the org billing balance (refund minus Proofwork fee).
      const orgId = row.org_id;
      const acct =
        (await trx.selectFrom('billing_accounts').selectAll().where('org_id', '=', orgId).executeTakeFirst()) ??
        (await trx
          .insertInto('billing_accounts')
          .values({
            id: `acct_${orgId}`,
            org_id: orgId,
            balance_cents: 0,
            currency: 'usd',
            created_at: now,
            updated_at: now,
          } satisfies Selectable<BillingAccountsTable>)
          .onConflict((oc) => oc.column('org_id').doNothing())
          .returningAll()
          .executeTakeFirst()) ??
        (await trx.selectFrom('billing_accounts').selectAll().where('org_id', '=', orgId).executeTakeFirstOrThrow());

      if (refundCents > 0) {
        await trx
          .updateTable('billing_accounts')
          .set({ balance_cents: sql`balance_cents + ${refundCents}`, updated_at: now })
          .where('id', '=', acct.id)
          .execute();

        await trx
          .insertInto('billing_events')
          .values({
            id: nanoid(12),
            account_id: acct.id,
            event_type: 'dispute_refund',
            amount_cents: refundCents,
            metadata_json: { disputeId, payoutId, proofworkFeeCents: proofworkFee },
            created_at: now,
          } satisfies Selectable<BillingEventsTable>)
          .execute();
      }

      // Mark payout refunded (final).
      await trx
        .updateTable('payouts')
        .set({ status: 'refunded', blocked_reason: 'dispute_refund', updated_at: now })
        .where('id', '=', payoutId)
        .execute();

      // Mark submission payout_status reversed (best-effort).
      if (row.submission_id) {
        await trx.updateTable('submissions').set({ payout_status: 'reversed' }).where('id', '=', row.submission_id).execute();
      }

      // Stop any pending payout outbox events for this payout.
      await trx
        .updateTable('outbox_events')
        .set({ status: 'sent', sent_at: now, locked_at: null, locked_by: null, last_error: null })
        .where('topic', '=', 'payout.requested')
        .where('idempotency_key', '=', `payout:${payoutId}`)
        .execute();

      const updated = await trx
        .updateTable('disputes')
        .set({
          status: 'resolved',
          resolved_at: now,
          resolver_actor_type: actor.actorType,
          resolver_actor_id: actor.actorId,
          resolution: 'refund',
          resolution_notes: input.notes ?? null,
        })
        .where('id', '=', disputeId)
        .returningAll()
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('audit_log')
        .values({
          id: nanoid(12),
          actor_type: actor.actorType,
          actor_id: actor.actorId,
          action: 'dispute.resolve_refund',
          target_type: 'dispute',
          target_id: disputeId,
          metadata: { refundCents, proofworkFeeCents: proofworkFee },
          created_at: now,
        })
        .execute();

      return disputeFromRow(updated);
    }

    // uphold: clear block and re-schedule payout request at max(now, hold_until)
    await trx.updateTable('payouts').set({ blocked_reason: null, updated_at: now }).where('id', '=', payoutId).execute();

    const nextAt = payoutRow.hold_until && (payoutRow.hold_until as any as Date).getTime() > Date.now() ? payoutRow.hold_until : now;

    const existingEvt = await trx
      .selectFrom('outbox_events')
      .select(['id'])
      .where('topic', '=', 'payout.requested')
      .where('idempotency_key', '=', `payout:${payoutId}`)
      .executeTakeFirst();

    if (existingEvt?.id) {
      await trx
        .updateTable('outbox_events')
        .set({ status: 'pending', available_at: nextAt, locked_at: null, locked_by: null, last_error: null })
        .where('id', '=', existingEvt.id)
        .execute();
    } else {
      await trx
        .insertInto('outbox_events')
        .values({
          id: nanoid(12),
          topic: 'payout.requested',
          idempotency_key: `payout:${payoutId}`,
          payload: { payoutId, submissionId: row.submission_id, workerId: payoutRow.worker_id },
          status: 'pending',
          attempts: 0,
          available_at: nextAt,
          locked_at: null,
          locked_by: null,
          last_error: null,
          created_at: now,
          sent_at: null,
        } satisfies Selectable<OutboxEventsTable>)
        .execute();
    }

    const updated = await trx
      .updateTable('disputes')
      .set({
        status: 'resolved',
        resolved_at: now,
        resolver_actor_type: actor.actorType,
        resolver_actor_id: actor.actorId,
        resolution: 'uphold',
        resolution_notes: input.notes ?? null,
      })
      .where('id', '=', disputeId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('audit_log')
      .values({
        id: nanoid(12),
        actor_type: actor.actorType,
        actor_id: actor.actorId,
        action: 'dispute.resolve_uphold',
        target_type: 'dispute',
        target_id: disputeId,
        metadata: {},
        created_at: now,
      })
      .execute();

    return disputeFromRow(updated);
  });
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

export async function getOrgCorsAllowOrigins(orgId: string): Promise<string[] | undefined> {
  const row = await db.selectFrom('orgs').select(['cors_allow_origins']).where('id', '=', orgId).executeTakeFirst();
  if (!row) return undefined;
  const raw = (row as any).cors_allow_origins;
  return Array.isArray(raw) ? raw.filter((o: any) => typeof o === 'string' && o.length) : [];
}

export async function setOrgCorsAllowOrigins(orgId: string, origins: string[]): Promise<string[] | undefined> {
  const row = await db
    .updateTable('orgs')
    .set({ cors_allow_origins: JSON.stringify(origins) })
    .where('id', '=', orgId)
    .returning(['cors_allow_origins'])
    .executeTakeFirst();
  if (!row) return undefined;
  const raw = (row as any).cors_allow_origins;
  return Array.isArray(raw) ? raw.filter((o: any) => typeof o === 'string' && o.length) : [];
}

export async function getOrgQuotaSettings(orgId: string): Promise<
  | {
      orgId: string;
      dailySpendLimitCents: number | null;
      monthlySpendLimitCents: number | null;
      maxOpenJobs: number | null;
    }
  | undefined
> {
  const row = await db
    .selectFrom('orgs')
    .select(['id', 'daily_spend_limit_cents', 'monthly_spend_limit_cents', 'max_open_jobs'])
    .where('id', '=', orgId)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    orgId: row.id,
    dailySpendLimitCents: row.daily_spend_limit_cents ?? null,
    monthlySpendLimitCents: row.monthly_spend_limit_cents ?? null,
    maxOpenJobs: row.max_open_jobs ?? null,
  };
}

export async function setOrgQuotaSettings(
  orgId: string,
  input: { dailySpendLimitCents?: number | null; monthlySpendLimitCents?: number | null; maxOpenJobs?: number | null }
): Promise<{ orgId: string; dailySpendLimitCents: number | null; monthlySpendLimitCents: number | null; maxOpenJobs: number | null } | undefined> {
  const patch: any = {};
  if (Object.prototype.hasOwnProperty.call(input, 'dailySpendLimitCents')) patch.daily_spend_limit_cents = input.dailySpendLimitCents ?? null;
  if (Object.prototype.hasOwnProperty.call(input, 'monthlySpendLimitCents')) patch.monthly_spend_limit_cents = input.monthlySpendLimitCents ?? null;
  if (Object.prototype.hasOwnProperty.call(input, 'maxOpenJobs')) patch.max_open_jobs = input.maxOpenJobs ?? null;
  const row = await db.updateTable('orgs').set(patch).where('id', '=', orgId).returning(['id', 'daily_spend_limit_cents', 'monthly_spend_limit_cents', 'max_open_jobs']).executeTakeFirst();
  if (!row) return undefined;
  return {
    orgId: row.id,
    dailySpendLimitCents: row.daily_spend_limit_cents ?? null,
    monthlySpendLimitCents: row.monthly_spend_limit_cents ?? null,
    maxOpenJobs: row.max_open_jobs ?? null,
  };
}

export async function listAllCorsAllowOrigins(): Promise<string[]> {
  // For preflight requests we cannot determine org from tokens. This returns a stable union set.
  const res = await pool.query<{ origin: string }>(
    `
    SELECT DISTINCT jsonb_array_elements_text(cors_allow_origins) AS origin
    FROM orgs
    WHERE cors_allow_origins IS NOT NULL
      AND jsonb_typeof(cors_allow_origins) = 'array'
    `
  );
  return res.rows.map((r) => String(r.origin)).filter(Boolean);
}

export type ResolveResult = { found: boolean; type?: string; meta?: Record<string, any> };

function normalizeResolveId(id: string): string {
  const s = String(id ?? '').trim();
  // Guard: prevent log spam / accidental large queries.
  if (s.length > 200) return s.slice(0, 200);
  return s;
}

export async function resolveIdAdmin(idRaw: string): Promise<ResolveResult> {
  const id = normalizeResolveId(idRaw);
  if (!id) return { found: false };

  const app = await db.selectFrom('apps').select(['id', 'slug', 'task_type']).where('id', '=', id).executeTakeFirst();
  if (app) return { found: true, type: 'app', meta: { slug: app.slug, taskType: app.task_type } };

  const bounty = await db.selectFrom('bounties').select(['id', 'org_id', 'title']).where('id', '=', id).executeTakeFirst();
  if (bounty) return { found: true, type: 'bounty', meta: { orgId: bounty.org_id, title: bounty.title } };

  const job = await db.selectFrom('jobs').select(['id', 'bounty_id', 'status']).where('id', '=', id).executeTakeFirst();
  if (job) return { found: true, type: 'job', meta: { bountyId: job.bounty_id, status: job.status } };

  const sub = await db.selectFrom('submissions').select(['id', 'job_id', 'worker_id', 'status']).where('id', '=', id).executeTakeFirst();
  if (sub) return { found: true, type: 'submission', meta: { jobId: sub.job_id, workerId: sub.worker_id, status: sub.status } };

  const payout = await db
    .selectFrom('payouts')
    .select(['id', 'submission_id', 'worker_id', 'status', 'blocked_reason', 'hold_until'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (payout)
    return {
      found: true,
      type: 'payout',
      meta: {
        submissionId: payout.submission_id,
        workerId: payout.worker_id,
        status: payout.status,
        blockedReason: payout.blocked_reason ?? null,
        holdUntil: payout.hold_until ? (payout.hold_until as any as Date).toISOString() : null,
      },
    };

  const dispute = await db
    .selectFrom('disputes')
    .select(['id', 'org_id', 'submission_id', 'payout_id', 'status', 'resolution'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (dispute)
    return {
      found: true,
      type: 'dispute',
      meta: {
        orgId: dispute.org_id,
        submissionId: dispute.submission_id ?? null,
        payoutId: dispute.payout_id ?? null,
        status: dispute.status,
        resolution: dispute.resolution ?? null,
      },
    };

  const artifact = await db
    .selectFrom('artifacts')
    .select(['id', 'submission_id', 'job_id', 'worker_id', 'kind', 'status'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (artifact)
    return {
      found: true,
      type: 'artifact',
      meta: {
        submissionId: artifact.submission_id ?? null,
        jobId: artifact.job_id ?? null,
        workerId: artifact.worker_id ?? null,
        kind: artifact.kind,
        status: artifact.status,
      },
    };

  const origin = await db.selectFrom('origins').select(['id', 'org_id', 'origin', 'status']).where('id', '=', id).executeTakeFirst();
  if (origin) return { found: true, type: 'origin', meta: { orgId: origin.org_id, origin: origin.origin, status: origin.status } };

  const ver = await db
    .selectFrom('verifications')
    .select(['id', 'submission_id', 'attempt_no', 'status', 'verdict'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (ver)
    return {
      found: true,
      type: 'verification',
      meta: { submissionId: ver.submission_id, attemptNo: ver.attempt_no, status: ver.status, verdict: ver.verdict ?? null },
    };

  const worker = await db.selectFrom('workers').select(['id', 'display_name', 'status']).where('id', '=', id).executeTakeFirst();
  if (worker) return { found: true, type: 'worker', meta: { displayName: worker.display_name ?? null, status: worker.status } };

  const alarm = await db.selectFrom('alarm_notifications').select(['id', 'environment', 'alarm_name']).where('id', '=', id).executeTakeFirst();
  if (alarm) return { found: true, type: 'alarm_notification', meta: { environment: alarm.environment, alarmName: alarm.alarm_name ?? null } };

  return { found: false };
}

export async function resolveIdOrg(orgId: string, idRaw: string): Promise<ResolveResult> {
  const id = normalizeResolveId(idRaw);
  if (!id) return { found: false };

  const app = await db.selectFrom('apps').select(['id', 'slug', 'task_type']).where('id', '=', id).where('owner_org_id', '=', orgId).executeTakeFirst();
  if (app) return { found: true, type: 'app', meta: { slug: app.slug, taskType: app.task_type } };

  const origin = await db.selectFrom('origins').select(['id', 'origin', 'status']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (origin) return { found: true, type: 'origin', meta: { origin: origin.origin, status: origin.status } };

  const bounty = await db.selectFrom('bounties').select(['id', 'title', 'status']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (bounty) return { found: true, type: 'bounty', meta: { title: bounty.title, status: bounty.status } };

  const job = await db
    .selectFrom('jobs as j')
    .innerJoin('bounties as b', 'b.id', 'j.bounty_id')
    .select(['j.id as id', 'j.bounty_id as bounty_id', 'j.status as status'])
    .where('j.id', '=', id)
    .where('b.org_id', '=', orgId)
    .executeTakeFirst();
  if (job) return { found: true, type: 'job', meta: { bountyId: (job as any).bounty_id, status: (job as any).status } };

  const sub = await db
    .selectFrom('submissions as s')
    .innerJoin('jobs as j', 'j.id', 's.job_id')
    .innerJoin('bounties as b', 'b.id', 'j.bounty_id')
    .select(['s.id as id', 's.job_id as job_id', 's.worker_id as worker_id', 's.status as status'])
    .where('s.id', '=', id)
    .where('b.org_id', '=', orgId)
    .executeTakeFirst();
  if (sub) return { found: true, type: 'submission', meta: { jobId: (sub as any).job_id, workerId: (sub as any).worker_id, status: (sub as any).status } };

  const payout = await db
    .selectFrom('payouts as p')
    .innerJoin('submissions as s', 's.id', 'p.submission_id')
    .innerJoin('jobs as j', 'j.id', 's.job_id')
    .innerJoin('bounties as b', 'b.id', 'j.bounty_id')
    .select(['p.id as id', 'p.status as status', 'p.blocked_reason as blocked_reason', 'p.hold_until as hold_until'])
    .where('p.id', '=', id)
    .where('b.org_id', '=', orgId)
    .executeTakeFirst();
  if (payout)
    return {
      found: true,
      type: 'payout',
      meta: {
        status: (payout as any).status,
        blockedReason: (payout as any).blocked_reason ?? null,
        holdUntil: (payout as any).hold_until ? ((payout as any).hold_until as Date).toISOString() : null,
      },
    };

  const dispute = await db
    .selectFrom('disputes')
    .select(['id', 'submission_id', 'payout_id', 'status', 'resolution'])
    .where('id', '=', id)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (dispute)
    return {
      found: true,
      type: 'dispute',
      meta: {
        submissionId: dispute.submission_id ?? null,
        payoutId: dispute.payout_id ?? null,
        status: dispute.status,
        resolution: dispute.resolution ?? null,
      },
    };

  const artifact = await db
    .selectFrom('artifacts as a')
    .innerJoin('jobs as j', (jb) => jb.onRef('j.id', '=', 'a.job_id'))
    .innerJoin('bounties as b', 'b.id', 'j.bounty_id')
    .select(['a.id as id', 'a.kind as kind', 'a.status as status'])
    .where('a.id', '=', id)
    .where('b.org_id', '=', orgId)
    .executeTakeFirst();
  if (artifact) return { found: true, type: 'artifact', meta: { kind: (artifact as any).kind, status: (artifact as any).status } };

  return { found: false };
}

export async function resolveIdWorker(workerId: string, idRaw: string): Promise<ResolveResult> {
  const id = normalizeResolveId(idRaw);
  if (!id) return { found: false };

  if (id === workerId) {
    return { found: true, type: 'worker', meta: { workerId } };
  }

  const sub = await db.selectFrom('submissions').select(['id', 'job_id', 'status']).where('id', '=', id).where('worker_id', '=', workerId).executeTakeFirst();
  if (sub) return { found: true, type: 'submission', meta: { jobId: sub.job_id, status: sub.status } };

  const payout = await db.selectFrom('payouts').select(['id', 'status', 'blocked_reason', 'hold_until']).where('id', '=', id).where('worker_id', '=', workerId).executeTakeFirst();
  if (payout)
    return {
      found: true,
      type: 'payout',
      meta: {
        status: payout.status,
        blockedReason: payout.blocked_reason ?? null,
        holdUntil: payout.hold_until ? (payout.hold_until as any as Date).toISOString() : null,
      },
    };

  const artifact = await db
    .selectFrom('artifacts')
    .select(['id', 'kind', 'status'])
    .where('id', '=', id)
    .where('worker_id', '=', workerId)
    .executeTakeFirst();
  if (artifact) return { found: true, type: 'artifact', meta: { kind: artifact.kind, status: artifact.status } };

  const leasedJob = await db
    .selectFrom('jobs')
    .select(['id', 'bounty_id', 'status'])
    .where('id', '=', id)
    .where('lease_worker_id', '=', workerId)
    .executeTakeFirst();
  if (leasedJob) return { found: true, type: 'job', meta: { bountyId: leasedJob.bounty_id, status: leasedJob.status } };

  const hasSub = await db
    .selectFrom('submissions')
    .select(['id'])
    .where('job_id', '=', id)
    .where('worker_id', '=', workerId)
    .executeTakeFirst();
  if (hasSub) {
    const job = await db.selectFrom('jobs').select(['id', 'bounty_id', 'status']).where('id', '=', id).executeTakeFirst();
    if (job) return { found: true, type: 'job', meta: { bountyId: job.bounty_id, status: job.status } };
  }

  return { found: false };
}
