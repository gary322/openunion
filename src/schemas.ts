import { z } from 'zod';

export const capabilityTagEnum = z.enum(['browser', 'http', 'ffmpeg', 'llm_summarize', 'screenshot']);
export const artifactKindEnum = z.enum(['screenshot', 'snapshot', 'pdf', 'log', 'video', 'other']);

// Zod v4 changed `z.record` signature to (keySchema, valueSchema). Use string keys explicitly.
const jsonRecord = () => z.record(z.string(), z.any());

const requiredArtifactSpecSchema = z
  .object({
    kind: artifactKindEnum,
    count: z.number().int().min(1).max(20).optional(),
    label_prefix: z.string().min(1).max(200).optional(),
    label: z.string().min(1).max(200).optional(),
  })
  .passthrough();

const outputSpecSchema = z
  .object({
    required_artifacts: z.array(requiredArtifactSpecSchema).min(1).max(50).optional(),
  })
  .passthrough()
  .default({});

export const taskDescriptorSchema = z.object({
  schema_version: z.literal('v1').default('v1'),
  type: z.string().min(1).max(120),
  capability_tags: z.array(capabilityTagEnum).min(1).max(20),
  input_spec: jsonRecord().default({}),
  output_spec: outputSpecSchema,
  freshness_sla_sec: z.number().int().positive().max(86_400).optional(),
  site_profile: jsonRecord().optional(),
});

export const registerWorkerSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  capabilities: jsonRecord().default({}),
});

export const releaseJobLeaseSchema = z.object({
  leaseNonce: z.string().min(1).max(80),
  reason: z.string().min(1).max(500).optional(),
});

export const presignRequestSchema = z.object({
  jobId: z.string(),
  files: z.array(
    z.object({
      filename: z.string(),
      contentType: z.string(),
      sizeBytes: z.number().int().nonnegative().optional(),
    })
  ).min(1),
});

export const verifierPresignRequestSchema = z.object({
  submissionId: z.string(),
  files: z.array(
    z.object({
      filename: z.string(),
      contentType: z.string(),
      sizeBytes: z.number().int().nonnegative().optional(),
    })
  ).min(1),
});

export const uploadCompleteSchema = z.object({
  artifactId: z.string(),
  sha256: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});

export const artifactRefSchema = z.object({
  kind: artifactKindEnum,
  label: z.string(),
  sha256: z.string().min(8),
  url: z.string().url(),
  sizeBytes: z.number().int().nonnegative().optional(),
  contentType: z.string().optional(),
});

export const proofPackManifestSchema = z.object({
  manifestVersion: z.string(),
  jobId: z.string(),
  bountyId: z.string(),
  finalUrl: z.string().url().optional(),
  worker: z.object({
    workerId: z.string(),
    skillVersion: z.string(),
    fingerprint: jsonRecord(),
  }),
  result: z.object({
    outcome: z.enum(['success', 'failure']),
    failureType: z.enum(['blocker', 'confusion', 'performance', 'broken_link', 'other']).optional(),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    expected: z.string(),
    observed: z.string(),
    reproConfidence: z.enum(['high', 'medium', 'low']),
  }),
  reproSteps: z.array(z.string()).min(1),
  artifacts: z.array(artifactRefSchema).min(1),
  suggestedChange: z.object({ type: z.string().optional(), text: z.string().optional() }).optional(),
});

export const submitJobSchema = z.object({
  manifest: proofPackManifestSchema,
  artifactIndex: z.array(artifactRefSchema),
  notes: z.string().optional(),
});

export const workerPayoutAddressSchema = z.object({
  chain: z.enum(['base']),
  address: z.string(),
  signature: z.string(),
});

export const workerPayoutAddressMessageSchema = z.object({
  chain: z.enum(['base']),
  address: z.string(),
});

export const verifierClaimSchema = z.object({
  submissionId: z.string(),
  attemptNo: z.number().int().min(1),
  messageId: z.string(),
  idempotencyKey: z.string(),
  verifierInstanceId: z.string(),
  claimTtlSec: z.number().int().min(60).max(7200),
});

export const verifierVerdictSchema = z.object({
  verificationId: z.string(),
  claimToken: z.string(),
  submissionId: z.string(),
  jobId: z.string(),
  attemptNo: z.number().int().min(1),
  verdict: z.enum(['pass', 'fail', 'inconclusive']),
  reason: z.string(),
  scorecard: z.object({
    R: z.number().min(0).max(1),
    E: z.number().min(0).max(1),
    A: z.number().min(0).max(1),
    N: z.number().min(0).max(1),
    T: z.number().min(0).max(1),
    qualityScore: z.number(),
  }),
  evidenceArtifacts: z.array(artifactRefSchema),
  runMetadata: jsonRecord().optional(),
});

export const orgPlatformFeeSchema = z.object({
  platformFeeBps: z.number().int().min(0).max(10_000),
  // Base-chain EVM address. Required when platformFeeBps > 0.
  platformFeeWalletAddress: z.string().optional().nullable(),
});

export const orgCorsAllowlistSchema = z.object({
  origins: z.array(z.string().min(1).max(300)).max(100),
});

export const orgQuotasSchema = z.object({
  dailySpendLimitCents: z.number().int().min(0).nullable().optional(),
  monthlySpendLimitCents: z.number().int().min(0).nullable().optional(),
  maxOpenJobs: z.number().int().min(0).nullable().optional(),
});

export const orgRegisterSchema = z.object({
  orgName: z.string().min(2).max(80),
  email: z.string().min(3).max(200),
  password: z.string().min(8).max(200),
  apiKeyName: z.string().min(1).max(80).optional(),
});

export const appSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase alphanumeric with optional dashes');

// App-defined UI schema (friendly forms) used by /apps/app/:slug/ and built-in vertical pages.
// - Strict where it matters (field types + target paths), permissive elsewhere (passthrough) so
//   we can evolve the UX without breaking existing apps.
const appUiFieldTypeEnum = z.enum(['text', 'textarea', 'url', 'number', 'select', 'multiselect', 'boolean', 'date']);
const appUiTargetSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(input_spec|site_profile)\.[a-zA-Z0-9_][a-zA-Z0-9_.]*$/, 'target must start with input_spec. or site_profile.');

const appUiFieldSchema = z
  .object({
    key: z.string().min(1).max(80),
    label: z.string().min(1).max(160),
    type: appUiFieldTypeEnum,
    required: z.boolean().optional(),
    placeholder: z.string().max(400).optional(),
    help: z.string().max(1200).optional(),
    default: z.any().optional(),
    advanced: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    options: z
      .array(
        z.object({
          label: z.string().min(1).max(160),
          value: z.any(),
        })
      )
      .max(200)
      .optional(),
    target: appUiTargetSchema,
  })
  .passthrough();

const appUiSectionSchema = z
  .object({
    id: z.string().min(1).max(80),
    title: z.string().min(1).max(160),
    description: z.string().max(2000).optional(),
    fields: z.array(appUiFieldSchema).min(1).max(80),
  })
  .passthrough();

const appUiTemplateSchema = z
  .object({
    id: z.string().min(1).max(80),
    name: z.string().min(1).max(160),
    description: z.string().max(2000).optional(),
    preset: z.record(z.string(), z.any()).default({}),
  })
  .passthrough();

export const appUiSchemaSchema = z
  .object({
    schema_version: z.literal('v1').default('v1'),
    category: z.string().max(120).optional(),
    // Optional: used for smart defaults when creating bounties from app pages.
    bounty_defaults: z
      .object({
        payout_cents: z.number().int().min(0).max(10_000_000).optional(),
        required_proofs: z.number().int().min(0).max(50).optional(),
      })
      .optional(),
    sections: z.array(appUiSectionSchema).min(1).max(50),
    templates: z.array(appUiTemplateSchema).max(200).optional(),
  })
  .passthrough();

export const appCreateSchema = z.object({
  slug: appSlugSchema,
  taskType: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional().nullable(),
  dashboardUrl: z.string().max(500).optional().nullable(),
  public: z.boolean().optional(),
  defaultDescriptor: taskDescriptorSchema.optional(),
  uiSchema: appUiSchemaSchema.optional(),
});

export const appUpdateSchema = z.object({
  slug: appSlugSchema.optional(),
  taskType: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional().nullable(),
  dashboardUrl: z.string().max(500).optional().nullable(),
  public: z.boolean().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  defaultDescriptor: taskDescriptorSchema.optional(),
  uiSchema: appUiSchemaSchema.optional(),
});

export const disputeCreateSchema = z
  .object({
    payoutId: z.string().min(1).optional(),
    submissionId: z.string().min(1).optional(),
    reason: z.string().min(1).max(2000),
  })
  .refine((v) => Boolean(v.payoutId || v.submissionId), { message: 'payoutId or submissionId required' });

export const disputeResolveSchema = z.object({
  resolution: z.enum(['refund', 'uphold']),
  notes: z.string().max(5000).optional().nullable(),
});

export const adminAppStatusSchema = z.object({
  status: z.enum(['active', 'disabled']),
});

export const appOriginRequestCreateSchema = z.object({
  origin: z.string().min(1).max(300),
  message: z.string().max(2000).optional().nullable(),
});

export const adminOriginRequestReviewSchema = z.object({
  action: z.enum(['approve', 'reject']),
  notes: z.string().max(5000).optional().nullable(),
});

export const adminPayoutMarkSchema = z.object({
  status: z.enum(['paid', 'failed', 'refunded']),
  provider: z.string().max(120).optional().nullable(),
  providerRef: z.string().max(500).optional().nullable(),
  reason: z.string().min(3).max(2000),
});

export const blockedDomainCreateSchema = z.object({
  domain: z.string().min(1).max(200),
  reason: z.string().min(1).max(2000).optional().nullable(),
});

export const adminArtifactQuarantineSchema = z.object({
  reason: z.string().min(3).max(2000),
});
