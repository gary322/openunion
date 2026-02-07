export type WorkerStatus = 'active' | 'rate_limited' | 'banned';
export type JobStatus = 'open' | 'claimed' | 'submitted' | 'verifying' | 'done' | 'expired' | 'cancelled';
export type VerificationVerdict = 'pass' | 'fail' | 'inconclusive';
export type SubmissionStatus = 'submitted' | 'validated' | 'queued' | 'verifying' | 'accepted' | 'failed' | 'inconclusive' | 'duplicate' | 'blocked';

export interface Worker {
  id: string;
  displayName?: string;
  status: WorkerStatus;
  capabilities: Record<string, unknown>;
  rateLimitedUntil?: number;
}

export interface Reputation {
  workerId: string;
  alpha: number;
  beta: number;
}

export interface Bounty {
  id: string;
  orgId: string;
  title: string;
  description: string;
  allowedOrigins: string[];
  journey?: JourneySpec;
  payoutCents: number;
  coveragePayoutCents: number;
  requiredProofs: number;
  fingerprintClassesRequired: string[];
  priority?: number;
  disputeWindowSec?: number;
  status: 'draft' | 'published' | 'paused' | 'closed';
  tags: string[];
  taskDescriptor?: Record<string, unknown>;
}

export interface App {
  id: string;
  ownerOrgId: string;
  slug: string;
  taskType: string;
  name: string;
  description?: string;
  dashboardUrl?: string;
  public: boolean;
  status: 'active' | 'disabled';
  defaultDescriptor: Record<string, unknown>;
  publicAllowedOrigins: string[];
  uiSchema?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface Job {
  id: string;
  bountyId: string;
  fingerprintClass: string;
  status: JobStatus;
  leaseWorkerId?: string;
  leaseExpiresAt?: number; // epoch ms
  leaseNonce?: string;
  currentSubmissionId?: string;
  finalVerdict?: VerificationVerdict;
  finalReason?: string;
  finalQualityScore?: number;
  doneAt?: number;
  createdAt?: number;
  taskDescriptor?: Record<string, unknown>;
}

export interface Submission {
  id: string;
  jobId: string;
  workerId: string;
  idempotencyKey?: string;
  requestHash?: string;
  manifest: any;
  artifactIndex: any[];
  status: SubmissionStatus;
  dedupeKey?: string;
  finalVerdict?: VerificationVerdict;
  finalReason?: string;
  finalQualityScore?: number;
  payoutStatus?: 'none' | 'pending' | 'paid' | 'failed' | 'reversed';
  createdAt: number;
}

export interface Verification {
  id: string;
  submissionId: string;
  attemptNo: number;
  status: 'queued' | 'in_progress' | 'finished';
  claimToken?: string;
  claimedBy?: string;
  claimExpiresAt?: number;
  verdict?: VerificationVerdict;
  reason?: string;
  scorecard?: Record<string, unknown>;
  evidence?: any[];
}

export interface EnvironmentProfile {
  fingerprintClass: string;
  locale?: string;
  timezone?: string;
  viewport?: { w: number; h: number };
}

export interface JourneySpec {
  startUrl: string;
  milestones: { id: string; hint: string }[];
  successCondition: { type: 'text_present' | 'url_matches' | 'selector_present'; value: string };
}

export interface JobSpecResponse {
  jobId: string;
  bountyId: string;
  requiredProofs: number;
  title: string;
  description?: string;
  taskDescriptor?: Record<string, unknown>;
  constraints: {
    allowedOrigins: string[];
    timeBudgetSec: number;
    maxRequestsPerMinute: number;
    doNotDo: string[];
  };
  environment: EnvironmentProfile;
  journey: JourneySpec;
  requiredEvidence: Record<string, unknown>;
  submissionFormat: { manifestVersion: string; requiredFiles: string[] };
  next_steps: string[];
}

export interface Envelope<TData = any> {
  state:
    | 'idle'
    | 'claimable'
    | 'claimed'
    | 'running'
    | 'submit'
    | 'verifying'
    | 'done'
    | 'blocked';
  next_steps: string[];
  constraints: Record<string, unknown>;
  submission_format: Record<string, unknown>;
  data: TData;
}
