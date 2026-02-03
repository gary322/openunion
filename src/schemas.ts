import { z } from 'zod';

export const capabilityTagEnum = z.enum(['browser', 'http', 'ffmpeg', 'llm_summarize', 'screenshot']);
export const artifactKindEnum = z.enum(['screenshot', 'snapshot', 'pdf', 'log', 'video', 'other']);

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
  input_spec: z.record(z.any()).default({}),
  output_spec: outputSpecSchema,
  freshness_sla_sec: z.number().int().positive().max(86_400).optional(),
  site_profile: z.record(z.any()).optional(),
});

export const registerWorkerSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  capabilities: z.record(z.any()).default({}),
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
    fingerprint: z.record(z.any()),
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
  runMetadata: z.record(z.any()).optional(),
});

export const orgPlatformFeeSchema = z.object({
  platformFeeBps: z.number().int().min(0).max(10_000),
  // Base-chain EVM address. Required when platformFeeBps > 0.
  platformFeeWalletAddress: z.string().optional().nullable(),
});

export const orgRegisterSchema = z.object({
  orgName: z.string().min(2).max(80),
  email: z.string().min(3).max(200),
  password: z.string().min(8).max(200),
  apiKeyName: z.string().min(1).max(80).optional(),
});
