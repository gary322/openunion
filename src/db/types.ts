import type { ColumnType } from 'kysely';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type Bigint = ColumnType<string, string | number | bigint, string | number | bigint>;

export interface WorkersTable {
  id: string;
  display_name: string | null;
  status: string;
  key_prefix: string;
  key_hash: string;
  capabilities_json: unknown;
  rate_limited_until: Timestamp | null;
  payout_chain: string | null;
  payout_address: string | null;
  payout_address_verified_at: Timestamp | null;
  payout_address_proof: unknown | null;
  created_at: Timestamp;
  last_seen_at: Timestamp | null;
}

export interface OrgsTable {
  id: string;
  name: string;
  platform_fee_bps: number;
  platform_fee_wallet_address: string | null;
  cors_allow_origins: unknown;
  daily_spend_limit_cents: number | null;
  monthly_spend_limit_cents: number | null;
  max_published_bounties: number | null;
  max_open_jobs: number | null;
  created_at: Timestamp;
}

export interface BountiesTable {
  id: string;
  org_id: string;
  title: string;
  description: string;
  status: string;
  allowed_origins: unknown;
  journey_json: unknown;
  payout_cents: number;
  coverage_payout_cents: number;
  required_proofs: number;
  fingerprint_classes_json: unknown;
  tags: unknown;
  dispute_window_sec: number;
  priority: number;
  task_descriptor: unknown | null;
  created_at: Timestamp;
  published_at: Timestamp | null;
}

export interface JobsTable {
  id: string;
  bounty_id: string;
  fingerprint_class: string;
  status: string;
  lease_worker_id: string | null;
  lease_expires_at: Timestamp | null;
  lease_nonce: string | null;
  current_submission_id: string | null;
  final_verdict: string | null;
  final_quality_score: number | null;
  done_at: Timestamp | null;
  task_descriptor: unknown | null;
  created_at: Timestamp;
}

export interface SubmissionsTable {
  id: string;
  job_id: string;
  worker_id: string;
  idempotency_key: string | null;
  request_hash: string | null;
  manifest_json: unknown;
  artifact_index_json: unknown;
  status: string;
  dedupe_key: string | null;
  final_verdict: string | null;
  final_quality_score: number | null;
  payout_status: string | null;
  created_at: Timestamp;
}

export interface VerificationsTable {
  id: string;
  submission_id: string;
  attempt_no: number;
  status: string;
  claim_token: string | null;
  claimed_by: string | null;
  claim_expires_at: Timestamp | null;
  verdict: string | null;
  reason: string | null;
  scorecard_json: unknown | null;
  evidence_json: unknown | null;
  created_at: Timestamp;
}

export interface PayoutsTable {
  id: string;
  submission_id: string;
  worker_id: string;
  amount_cents: number;
  status: string;
  provider: string | null;
  provider_ref: string | null;
  net_amount_cents: number | null;
  platform_fee_cents: number | null;
  platform_fee_bps: number | null;
  platform_fee_wallet_address: string | null;
  proofwork_fee_cents: number | null;
  proofwork_fee_bps: number | null;
  proofwork_fee_wallet_address: string | null;
  payout_chain: string | null;
  hold_until: Timestamp | null;
  blocked_reason: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ReputationTable {
  worker_id: string;
  alpha: number;
  beta: number;
  updated_at: Timestamp;
}

export interface AcceptedDedupeTable {
  bounty_id: string;
  dedupe_key: string;
  accepted_at: Timestamp;
}

export interface OrgUsersTable {
  id: string;
  org_id: string;
  email: string;
  password_hash: string;
  role: string;
  created_at: Timestamp;
}

export interface OrgApiKeysTable {
  id: string;
  org_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  revoked_at: Timestamp | null;
  last_used_at: Timestamp | null;
  created_at: Timestamp;
}

export interface OriginsTable {
  id: string;
  org_id: string;
  origin: string;
  status: string;
  method: string;
  token: string;
  verified_at: Timestamp | null;
  failure_reason: string | null;
  created_at: Timestamp;
}

export interface BlockedDomainsTable {
  id: string;
  domain: string;
  reason: string | null;
  created_at: Timestamp;
}

export interface BillingAccountsTable {
  id: string;
  org_id: string;
  balance_cents: number;
  currency: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface BillingEventsTable {
  id: string;
  account_id: string;
  event_type: string;
  amount_cents: number;
  metadata_json: unknown;
  created_at: Timestamp;
}

export interface BountyBudgetReservationsTable {
  id: string;
  account_id: string;
  bounty_id: string;
  amount_cents: number;
  status: string;
  created_at: Timestamp;
  released_at: Timestamp | null;
}

export interface PaymentIntentsTable {
  id: string;
  account_id: string;
  provider: string;
  provider_ref: string | null;
  amount_cents: number;
  status: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ArtifactsTable {
  id: string;
  submission_id: string | null;
  job_id: string | null;
  worker_id: string | null;
  kind: string;
  label: string | null;
  sha256: string | null;
  storage_key: string | null;
  final_url: string | null;
  content_type: string | null;
  size_bytes: number | null;
  status: string;
  bucket_kind: string | null;
  scan_engine: string | null;
  scan_started_at: Timestamp | null;
  scan_finished_at: Timestamp | null;
  scan_reason: string | null;
  quarantine_key: string | null;
  created_at: Timestamp;
  expires_at: Timestamp | null;
  deleted_at: Timestamp | null;
}

export interface OutboxEventsTable {
  id: string;
  topic: string;
  idempotency_key: string | null;
  payload: unknown;
  status: string;
  attempts: number;
  available_at: Timestamp;
  locked_at: Timestamp | null;
  locked_by: string | null;
  last_error: string | null;
  created_at: Timestamp;
  sent_at: Timestamp | null;
}

export interface RetentionPoliciesTable {
  id: string;
  org_id: string | null;
  name: string;
  applies_to: string;
  max_age_days: number | null;
  created_at: Timestamp;
}

export interface StripeCustomersTable {
  id: string;
  org_id: string;
  stripe_customer_id: string;
  created_at: Timestamp;
}

export interface StripeWebhookEventsTable {
  id: string;
  event_type: string;
  payload_json: unknown;
  received_at: Timestamp;
  processed_at: Timestamp | null;
  status: string;
  last_error: string | null;
}

export interface SessionsTable {
  id: string;
  user_id: string;
  org_id: string;
  role: string;
  csrf_secret: string;
  created_at: Timestamp;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
}

export interface DisputesTable {
  id: string;
  org_id: string;
  bounty_id: string;
  submission_id: string | null;
  payout_id: string | null;
  status: string;
  reason: string | null;
  resolution: string | null;
  resolution_notes: string | null;
  created_at: Timestamp;
  resolved_at: Timestamp | null;
  resolver_actor_type: string | null;
  resolver_actor_id: string | null;
}

export interface AppsTable {
  id: string;
  owner_org_id: string;
  slug: string;
  task_type: string;
  name: string;
  description: string | null;
  dashboard_url: string | null;
  public: boolean;
  status: string;
  default_descriptor: unknown;
  public_allowed_origins_json: unknown;
  ui_schema: unknown;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AppSupportedOriginsTable {
  app_id: string;
  origin: string;
  notes: string | null;
  created_at: Timestamp;
}

export interface MarketplaceOriginTemplatesTable {
  origin: string;
  enabled: boolean;
  search_url_template: string | null;
  wait_selector: string | null;
  selectors_json: unknown;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AppOriginRequestsTable {
  id: string;
  org_id: string;
  app_id: string;
  origin: string;
  status: string;
  message: string | null;
  reviewed_by: string | null;
  review_notes: string | null;
  created_at: Timestamp;
  reviewed_at: Timestamp | null;
}

export interface AlarmNotificationsTable {
  id: string;
  environment: string;
  topic_arn: string;
  sns_message_id: string | null;
  alarm_name: string | null;
  old_state_value: string | null;
  new_state_value: string | null;
  state_reason: string | null;
  state_change_time: Timestamp | null;
  raw_json: unknown;
  received_at: Timestamp;
}

export interface PayoutTransfersTable {
  id: string;
  payout_id: string;
  kind: string;
  chain_id: number;
  from_address: string;
  to_address: string;
  token: string;
  amount_base_units: Bigint;
  tx_hash: string | null;
  tx_nonce: Bigint | null;
  status: string;
  broadcast_at: Timestamp | null;
  confirmed_at: Timestamp | null;
  failure_reason: string | null;
  created_at: Timestamp;
}

export interface CryptoNoncesTable {
  chain_id: number;
  from_address: string;
  next_nonce: Bigint;
  updated_at: Timestamp;
}

export interface RetentionJobsTable {
  id: string;
  artifact_id: string;
  status: string;
  run_at: Timestamp;
  attempts: number;
  locked_at: Timestamp | null;
  locked_by: string | null;
  last_error: string | null;
  created_at: Timestamp;
  finished_at: Timestamp | null;
}

export interface AuditLogTable {
  id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: unknown;
  created_at: Timestamp;
}

export interface RateLimitBucketsTable {
  key: string;
  tokens: number;
  updated_at: Timestamp;
}

export interface SchemaMigrationsTable {
  filename: string;
  applied_at: Timestamp;
}

export interface DB {
  workers: WorkersTable;
  orgs: OrgsTable;
  apps: AppsTable;
  app_supported_origins: AppSupportedOriginsTable;
  marketplace_origin_templates: MarketplaceOriginTemplatesTable;
  app_origin_requests: AppOriginRequestsTable;
  alarm_notifications: AlarmNotificationsTable;
  blocked_domains: BlockedDomainsTable;
  bounties: BountiesTable;
  jobs: JobsTable;
  submissions: SubmissionsTable;
  verifications: VerificationsTable;
  payouts: PayoutsTable;
  reputation: ReputationTable;
  accepted_dedupe: AcceptedDedupeTable;

  org_users: OrgUsersTable;
  org_api_keys: OrgApiKeysTable;
  origins: OriginsTable;

  billing_accounts: BillingAccountsTable;
  billing_events: BillingEventsTable;
  bounty_budget_reservations: BountyBudgetReservationsTable;
  payment_intents: PaymentIntentsTable;

  artifacts: ArtifactsTable;
  outbox_events: OutboxEventsTable;
  retention_policies: RetentionPoliciesTable;
  retention_jobs: RetentionJobsTable;
  stripe_customers: StripeCustomersTable;
  stripe_webhook_events: StripeWebhookEventsTable;
  sessions: SessionsTable;
  disputes: DisputesTable;
  payout_transfers: PayoutTransfersTable;
  crypto_nonces: CryptoNoncesTable;
  audit_log: AuditLogTable;
  rate_limit_buckets: RateLimitBucketsTable;
  schema_migrations: SchemaMigrationsTable;
}
