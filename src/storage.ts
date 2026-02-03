import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { nanoid } from 'nanoid';
import path from 'path';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { db } from './db/client.js';
import { scanBytes } from './scanner.js';
import { scheduleArtifactDeletion } from './retention.js';

export type StorageBackend = 'local' | 's3';

export interface PresignFileRequest {
  filename: string;
  contentType: string;
  sizeBytes?: number;
}

export interface PresignUploadsInput {
  jobId: string;
  workerId: string;
  files: PresignFileRequest[];
  publicBaseUrl?: string;
}

export interface PresignedUpload {
  artifactId: string;
  filename: string;
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  finalUrl: string;
}

const STORAGE_BACKEND: StorageBackend = (process.env.STORAGE_BACKEND ?? 'local') as StorageBackend;
const STORAGE_LOCAL_DIR = process.env.STORAGE_LOCAL_DIR ?? './var/uploads';

const PRESIGN_TTL_SEC = Number(process.env.PRESIGN_TTL_SEC ?? 900);
const ARTIFACT_TTL_DAYS = Number(process.env.ARTIFACT_TTL_DAYS ?? 7);
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 15 * 1024 * 1024);

const ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'application/pdf',
  'application/json',
  'text/plain',
  'application/zip',
  'video/mp4',
  'application/octet-stream',
]);

function publicBaseUrlFromEnv(): string {
  return (process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}

export function extractArtifactIdFromUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/api\/artifacts\/([^/]+)\/download$/);
    return m?.[1];
  } catch {
    const m = url.match(/^\/api\/artifacts\/([^/]+)\/download$/);
    return m?.[1];
  }
}

function sanitizeFilename(filename: string) {
  const base = filename.trim().split('/').pop()?.split('\\').pop() ?? '';
  if (!base) throw new Error('invalid_filename');
  if (base.length > 200) throw new Error('invalid_filename');
  return base;
}

function validateFile(file: PresignFileRequest) {
  if (!file.filename) throw new Error('invalid_filename');
  if (!file.contentType || !ALLOWED_CONTENT_TYPES.has(file.contentType)) {
    throw new Error('content_type_not_allowed');
  }
  if (file.sizeBytes !== undefined && (!Number.isFinite(file.sizeBytes) || file.sizeBytes < 0)) {
    throw new Error('invalid_size');
  }
  if (file.sizeBytes !== undefined && file.sizeBytes > MAX_UPLOAD_BYTES) {
    throw new Error('too_large');
  }
}

let _s3: S3Client | undefined;

function s3Client(): S3Client {
  if (_s3) return _s3;
  const region = process.env.S3_REGION ?? 'us-east-1';
  const endpoint = process.env.STORAGE_ENDPOINT;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

  _s3 = new S3Client({
    region,
    endpoint,
    forcePathStyle: !!endpoint, // needed for MinIO/R2-style endpoints
    credentials:
      accessKeyId && secretAccessKey
        ? {
            accessKeyId,
            secretAccessKey,
          }
        : undefined,
  });
  return _s3;
}

type BucketKind = 'staging' | 'clean' | 'quarantine';

function bucketForKind(kind: BucketKind): string {
  const fallback = process.env.S3_BUCKET;
  const specific =
    kind === 'staging'
      ? process.env.S3_BUCKET_STAGING
      : kind === 'clean'
        ? process.env.S3_BUCKET_CLEAN
        : process.env.S3_BUCKET_QUARANTINE;

  const bucket = specific ?? fallback;
  if (!bucket) throw new Error('S3_BUCKET (or S3_BUCKET_* for staging/clean/quarantine) is required when STORAGE_BACKEND=s3');
  return bucket;
}

export async function presignUploads(input: PresignUploadsInput): Promise<{ uploads: PresignedUpload[] }> {
  const publicBaseUrl = (input.publicBaseUrl ?? publicBaseUrlFromEnv()).replace(/\/$/, '');
  if (!Array.isArray(input.files) || input.files.length === 0) {
    return { uploads: [] };
  }
  if (input.files.length > 10) {
    throw new Error('too_many_files');
  }

  const uploads: PresignedUpload[] = [];
  // Apply org-scoped retention policy if present.
  let ttlDays = ARTIFACT_TTL_DAYS;
  const orgRow = await db
    .selectFrom('jobs')
    .innerJoin('bounties', 'bounties.id', 'jobs.bounty_id')
    .select(['bounties.org_id as org_id'])
    .where('jobs.id', '=', input.jobId)
    .executeTakeFirst();
  const orgId = (orgRow as any)?.org_id as string | undefined;
  if (orgId) {
    const policy = await db
      .selectFrom('retention_policies')
      .select(['max_age_days'])
      .where('org_id', '=', orgId)
      .where('applies_to', '=', 'artifacts')
      .executeTakeFirst();
    if (policy?.max_age_days !== null && policy?.max_age_days !== undefined) {
      ttlDays = Number(policy.max_age_days);
    }
  }

  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  for (const f of input.files) {
    validateFile(f);
    const filename = sanitizeFilename(f.filename);
    const artifactId = nanoid(12);
    const storageKey = `artifacts/${artifactId}/${filename}`;
    const finalUrl = `${publicBaseUrl}/api/artifacts/${artifactId}/download`;

    await db
      .insertInto('artifacts')
      .values({
        id: artifactId,
        submission_id: null,
        job_id: input.jobId,
        worker_id: input.workerId,
        kind: 'other',
        label: filename,
        sha256: null,
        storage_key: storageKey,
        final_url: finalUrl,
        content_type: f.contentType,
        size_bytes: f.sizeBytes ?? null,
        status: 'presigned',
        bucket_kind: STORAGE_BACKEND === 's3' ? 'staging' : null,
        created_at: new Date(),
        expires_at: expiresAt,
        deleted_at: null,
      })
      .execute();

    await scheduleArtifactDeletion(artifactId, expiresAt);

    if (STORAGE_BACKEND === 'local') {
      uploads.push({
        artifactId,
        filename,
        url: `${publicBaseUrl}/api/uploads/local/${artifactId}`,
        method: 'PUT',
        headers: { 'Content-Type': f.contentType },
        finalUrl,
      });
      continue;
    }

    if (STORAGE_BACKEND === 's3') {
      const bucket = bucketForKind('staging');
      const url = await getSignedUrl(s3Client(), new PutObjectCommand({ Bucket: bucket, Key: storageKey, ContentType: f.contentType }), {
        expiresIn: PRESIGN_TTL_SEC,
      });
      uploads.push({
        artifactId,
        filename,
        url,
        method: 'PUT',
        headers: { 'Content-Type': f.contentType },
        finalUrl,
      });
      continue;
    }

    throw new Error(`Unsupported STORAGE_BACKEND: ${STORAGE_BACKEND}`);
  }

  return { uploads };
}

export async function presignVerifierUploads(input: {
  submissionId: string;
  jobId: string;
  files: PresignFileRequest[];
  publicBaseUrl?: string;
}): Promise<{ uploads: PresignedUpload[] }> {
  const publicBaseUrl = (input.publicBaseUrl ?? publicBaseUrlFromEnv()).replace(/\/$/, '');
  if (!Array.isArray(input.files) || input.files.length === 0) return { uploads: [] };
  if (input.files.length > 20) throw new Error('too_many_files');

  const uploads: PresignedUpload[] = [];

  // Apply org-scoped retention policy if present.
  let ttlDays = ARTIFACT_TTL_DAYS;
  const orgRow = await db
    .selectFrom('jobs')
    .innerJoin('bounties', 'bounties.id', 'jobs.bounty_id')
    .select(['bounties.org_id as org_id'])
    .where('jobs.id', '=', input.jobId)
    .executeTakeFirst();
  const orgId = (orgRow as any)?.org_id as string | undefined;
  if (orgId) {
    const policy = await db
      .selectFrom('retention_policies')
      .select(['max_age_days'])
      .where('org_id', '=', orgId)
      .where('applies_to', '=', 'artifacts')
      .executeTakeFirst();
    if (policy?.max_age_days !== null && policy?.max_age_days !== undefined) {
      ttlDays = Number(policy.max_age_days);
    }
  }

  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  for (const f of input.files) {
    validateFile(f);
    const filename = sanitizeFilename(f.filename);
    const artifactId = nanoid(12);
    const storageKey = `artifacts/${artifactId}/${filename}`;
    const finalUrl = `${publicBaseUrl}/api/artifacts/${artifactId}/download`;

    const lower = filename.toLowerCase();
    const kind = lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'screenshot' : lower.endsWith('.log') || lower.endsWith('.txt') ? 'log' : 'other';

    await db
      .insertInto('artifacts')
      .values({
        id: artifactId,
        submission_id: input.submissionId,
        job_id: input.jobId,
        worker_id: null,
        kind,
        label: filename,
        sha256: null,
        storage_key: storageKey,
        final_url: finalUrl,
        content_type: f.contentType,
        size_bytes: f.sizeBytes ?? null,
        status: 'presigned',
        bucket_kind: STORAGE_BACKEND === 's3' ? 'staging' : null,
        created_at: new Date(),
        expires_at: expiresAt,
        deleted_at: null,
      })
      .execute();

    await scheduleArtifactDeletion(artifactId, expiresAt);

    if (STORAGE_BACKEND === 'local') {
      uploads.push({
        artifactId,
        filename,
        url: `${publicBaseUrl}/api/verifier/uploads/local/${artifactId}`,
        method: 'PUT',
        headers: { 'Content-Type': f.contentType },
        finalUrl,
      });
      continue;
    }

    if (STORAGE_BACKEND === 's3') {
      const bucket = bucketForKind('staging');
      const url = await getSignedUrl(s3Client(), new PutObjectCommand({ Bucket: bucket, Key: storageKey, ContentType: f.contentType }), {
        expiresIn: PRESIGN_TTL_SEC,
      });
      uploads.push({
        artifactId,
        filename,
        url,
        method: 'PUT',
        headers: { 'Content-Type': f.contentType },
        finalUrl,
      });
      continue;
    }

    throw new Error(`Unsupported STORAGE_BACKEND: ${STORAGE_BACKEND}`);
  }

  return { uploads };
}

export async function attachSubmissionArtifacts(input: {
  submissionId: string;
  jobId: string;
  workerId: string;
  artifactIndex: Array<{ kind: string; label: string; sha256: string; url: string; sizeBytes?: number; contentType?: string }>;
}) {
  let attached = 0;
  for (const ref of input.artifactIndex ?? []) {
    const artifactId = extractArtifactIdFromUrl(ref.url);
    if (!artifactId) continue; // external artifact URLs are ignored for now

    const art = await db.selectFrom('artifacts').selectAll().where('id', '=', artifactId).executeTakeFirst();
    if (!art) throw new Error('artifact_not_found');
    if (art.deleted_at) throw new Error('artifact_deleted');
    if (art.worker_id && art.worker_id !== input.workerId) throw new Error('artifact_forbidden');
    if (art.job_id && art.job_id !== input.jobId) throw new Error('artifact_wrong_job');
    if (art.status === 'blocked') throw new Error('artifact_blocked');

    // Require scan before the artifact can be attached to a submission.
    if (!['scanned', 'accepted'].includes(art.status)) {
      throw new Error('artifact_not_scanned');
    }

    await db
      .updateTable('artifacts')
      .set({
        submission_id: input.submissionId,
        kind: ref.kind,
        label: ref.label,
        sha256: ref.sha256,
        content_type: ref.contentType ?? art.content_type,
        size_bytes: ref.sizeBytes ?? art.size_bytes,
      })
      .where('id', '=', artifactId)
      .execute();
    attached += 1;
  }
  return attached;
}

export async function markSubmissionArtifactsAccepted(submissionId: string) {
  await db.updateTable('artifacts').set({ status: 'accepted' }).where('submission_id', '=', submissionId).execute();
}

export async function putLocalUpload(input: { artifactId: string; workerId: string; bytes: Buffer; contentType?: string }) {
  const row = await db.selectFrom('artifacts').selectAll().where('id', '=', input.artifactId).executeTakeFirst();
  if (!row) throw new Error('artifact_not_found');
  if (row.worker_id && row.worker_id !== input.workerId) throw new Error('forbidden');

  const contentType = input.contentType ?? row.content_type ?? 'application/octet-stream';
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) throw new Error('content_type_not_allowed');
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error('too_large');

  const storageKey = row.storage_key ?? `artifacts/${input.artifactId}/blob`;
  const rootDir = path.resolve(process.cwd(), STORAGE_LOCAL_DIR);
  const filePath = path.resolve(rootDir, storageKey);
  if (!filePath.startsWith(rootDir)) throw new Error('invalid_storage_key');

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, input.bytes);

  await db
    .updateTable('artifacts')
    .set({
      status: 'uploaded',
      content_type: contentType,
      size_bytes: input.bytes.byteLength,
    })
    .where('id', '=', input.artifactId)
    .execute();

  const scan = await scanBytes({ bytes: input.bytes, contentType, filename: row.label ?? undefined });
  if (!scan.ok) {
    await unlink(filePath).catch(() => undefined);
    await db.updateTable('artifacts').set({ status: 'blocked' }).where('id', '=', input.artifactId).execute();
    throw new Error(scan.reason ?? 'malware_detected');
  }

  await db
    .updateTable('artifacts')
    .set({
      status: 'scanned',
    })
    .where('id', '=', input.artifactId)
    .execute();
}

export async function putVerifierLocalUpload(input: { artifactId: string; bytes: Buffer; contentType?: string }) {
  const row = await db.selectFrom('artifacts').selectAll().where('id', '=', input.artifactId).executeTakeFirst();
  if (!row) throw new Error('artifact_not_found');
  if (row.worker_id) throw new Error('forbidden');

  const contentType = input.contentType ?? row.content_type ?? 'application/octet-stream';
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) throw new Error('content_type_not_allowed');
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error('too_large');

  const storageKey = row.storage_key ?? `artifacts/${input.artifactId}/blob`;
  const rootDir = path.resolve(process.cwd(), STORAGE_LOCAL_DIR);
  const filePath = path.resolve(rootDir, storageKey);
  if (!filePath.startsWith(rootDir)) throw new Error('invalid_storage_key');

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, input.bytes);

  const scanStartedAt = new Date();
  await db
    .updateTable('artifacts')
    .set({
      status: 'uploaded',
      content_type: contentType,
      size_bytes: input.bytes.byteLength,
      scan_started_at: scanStartedAt,
    })
    .where('id', '=', input.artifactId)
    .execute();

  const scan = await scanBytes({ bytes: input.bytes, contentType, filename: row.label ?? undefined });
  const scanFinishedAt = new Date();
  if (!scan.ok) {
    await unlink(filePath).catch(() => undefined);
    await db
      .updateTable('artifacts')
      .set({
        status: 'blocked',
        scan_engine: process.env.SCANNER_ENGINE ?? 'basic',
        scan_finished_at: scanFinishedAt,
        scan_reason: scan.reason ?? 'malware_detected',
      })
      .where('id', '=', input.artifactId)
      .execute();
    throw new Error(scan.reason ?? 'malware_detected');
  }

  await db
    .updateTable('artifacts')
    .set({
      status: 'scanned',
      scan_engine: process.env.SCANNER_ENGINE ?? 'basic',
      scan_finished_at: scanFinishedAt,
      scan_reason: null,
    })
    .where('id', '=', input.artifactId)
    .execute();
}

export async function getArtifactAccessInfo(artifactId: string): Promise<
  | undefined
  | {
      id: string;
      status: string;
      deletedAt: Date | null;
      storageKey: string | null;
      contentType: string | null;
      bucketKind: string | null;
      scanEngine: string | null;
      scanStartedAt: Date | null;
      scanFinishedAt: Date | null;
      scanReason: string | null;
      sizeBytes: number | null;
      workerId: string | null;
      orgId: string | null;
    }
> {
  const artifact = await db.selectFrom('artifacts').selectAll().where('id', '=', artifactId).executeTakeFirst();
  if (!artifact) return undefined;

  let orgId: string | null = null;
  if (artifact.job_id) {
    const row = await db
      .selectFrom('jobs')
      .innerJoin('bounties', 'bounties.id', 'jobs.bounty_id')
      .select(['bounties.org_id as org_id'])
      .where('jobs.id', '=', artifact.job_id)
      .executeTakeFirst();
    orgId = (row as any)?.org_id ?? null;
  } else if (artifact.submission_id) {
    const row = await db
      .selectFrom('submissions')
      .innerJoin('jobs', 'jobs.id', 'submissions.job_id')
      .innerJoin('bounties', 'bounties.id', 'jobs.bounty_id')
      .select(['bounties.org_id as org_id'])
      .where('submissions.id', '=', artifact.submission_id)
      .executeTakeFirst();
    orgId = (row as any)?.org_id ?? null;
  }

  return {
    id: artifact.id,
    status: artifact.status,
    deletedAt: artifact.deleted_at ?? null,
    storageKey: artifact.storage_key ?? null,
    contentType: artifact.content_type ?? null,
    bucketKind: (artifact as any).bucket_kind ?? null,
    scanEngine: (artifact as any).scan_engine ?? null,
    scanStartedAt: (artifact as any).scan_started_at ?? null,
    scanFinishedAt: (artifact as any).scan_finished_at ?? null,
    scanReason: (artifact as any).scan_reason ?? null,
    sizeBytes: (artifact as any).size_bytes ?? null,
    workerId: artifact.worker_id ?? null,
    orgId,
  };
}

export async function presignArtifactDownloadUrl(artifactId: string): Promise<string> {
  const row = await db.selectFrom('artifacts').selectAll().where('id', '=', artifactId).executeTakeFirst();
  if (!row) throw new Error('artifact_not_found');
  if (!row.storage_key) throw new Error('artifact_missing_storage_key');

  if (STORAGE_BACKEND === 's3') {
    if (row.status !== 'scanned' && row.status !== 'accepted') throw new Error('artifact_not_scanned');
    if (row.bucket_kind !== 'clean') throw new Error('artifact_not_in_clean_bucket');
    const bucket = bucketForKind('clean');
    return await getSignedUrl(s3Client(), new GetObjectCommand({ Bucket: bucket, Key: row.storage_key }), {
      expiresIn: PRESIGN_TTL_SEC,
    });
  }

  // Local downloads are proxied through the API.
  const publicBaseUrl = publicBaseUrlFromEnv();
  return `${publicBaseUrl}/api/artifacts/${artifactId}/download`;
}

export function localPathForStorageKey(storageKey: string) {
  const rootDir = path.resolve(process.cwd(), STORAGE_LOCAL_DIR);
  const filePath = path.resolve(rootDir, storageKey);
  if (!filePath.startsWith(rootDir)) throw new Error('invalid_storage_key');
  return { rootDir, filePath };
}

async function streamToBuffer(stream: any, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  // Readable streams in Node are async-iterable.
  for await (const chunk of stream as any) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) throw new Error('too_large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

async function deleteStorageObject(storageKey: string) {
  if (STORAGE_BACKEND === 'local') {
    const { filePath } = localPathForStorageKey(storageKey);
    await unlink(filePath).catch(() => undefined);
    return;
  }
  if (STORAGE_BACKEND === 's3') {
    // Default to staging bucket if bucket_kind is unknown.
    const bucket = bucketForKind('staging');
    await s3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }));
    return;
  }
}

function isDeterministicBlockReason(reason: string | undefined): boolean {
  const r = String(reason ?? '').toLowerCase();
  if (!r) return false;
  // Deterministic blocks: malformed bytes for declared content-type, explicit infected verdicts,
  // or other permanent policy failures.
  if (r === 'empty_file') return true;
  if (r.startsWith('content_type_mismatch_')) return true;
  if (r.includes('infected')) return true;
  if (r.includes('malware_detected')) return true;
  return false;
}

function isScannerErrorReason(reason: string | undefined): boolean {
  const r = String(reason ?? '').toLowerCase();
  if (!r) return true;
  // Treat scanner connectivity/timeouts/parsing as retryable (do not quarantine).
  if (r.startsWith('clamd_') && !r.includes('infected')) return true;
  if (r.startsWith('clamav_error')) return true;
  if (r.startsWith('clamav_spawn_error')) return true;
  return false;
}

export async function scanArtifactObject(artifactId: string) {
  const row = await db.selectFrom('artifacts').selectAll().where('id', '=', artifactId).executeTakeFirst();
  if (!row || row.deleted_at) return;
  if (!row.storage_key) throw new Error('artifact_missing_storage_key');
  if (['scanned', 'accepted', 'blocked', 'deleted'].includes(row.status)) return;

  let bytes: Buffer;
  const scanStartedAt = new Date();
  if (STORAGE_BACKEND === 'local') {
    const { filePath } = localPathForStorageKey(row.storage_key);
    bytes = await readFile(filePath);
  } else if (STORAGE_BACKEND === 's3') {
    // Only scan from staging.
    const stagingBucket = bucketForKind('staging');
    const res = await s3Client().send(new GetObjectCommand({ Bucket: stagingBucket, Key: row.storage_key }));
    if (!res.Body) throw new Error('artifact_body_missing');
    bytes = await streamToBuffer(res.Body as any, MAX_UPLOAD_BYTES);
  } else {
    throw new Error(`unsupported_storage_backend:${STORAGE_BACKEND}`);
  }

  // Mark uploaded before scan (useful for S3 complete -> scan flow).
  await db
    .updateTable('artifacts')
    .set({
      status: 'uploaded',
      content_type: row.content_type ?? undefined,
      size_bytes: row.size_bytes ?? bytes.byteLength,
      scan_started_at: scanStartedAt,
    })
    .where('id', '=', artifactId)
    .execute();

  const scan = await scanBytes({ bytes, contentType: row.content_type ?? undefined, filename: row.label ?? undefined });
  const scanFinishedAt = new Date();

  if (STORAGE_BACKEND === 's3') {
    const stagingBucket = bucketForKind('staging');
    const cleanBucket = bucketForKind('clean');
    const quarantineBucket = bucketForKind('quarantine');

    if (scan.ok) {
      // Copy to clean bucket and delete from staging.
      await s3Client().send(
        new CopyObjectCommand({
          Bucket: cleanBucket,
          Key: row.storage_key,
          CopySource: `${stagingBucket}/${row.storage_key}`,
          ContentType: row.content_type ?? undefined,
          MetadataDirective: 'COPY',
        })
      );
      await s3Client().send(new DeleteObjectCommand({ Bucket: stagingBucket, Key: row.storage_key }));

      await db
        .updateTable('artifacts')
        .set({
          status: 'scanned',
          bucket_kind: 'clean',
          scan_engine: process.env.SCANNER_ENGINE ?? 'basic',
          scan_finished_at: scanFinishedAt,
          scan_reason: null,
          quarantine_key: null,
        })
        .where('id', '=', artifactId)
        .execute();
      return;
    }

    const reason = scan.reason ?? 'scan_failed';
    const deterministicBlock = isDeterministicBlockReason(reason);
    const scannerError = isScannerErrorReason(reason);

    // Scanner engine failures (timeouts/connection errors) must be retryable; do not quarantine.
    if (!deterministicBlock && scannerError) {
      await db
        .updateTable('artifacts')
        .set({
          status: 'scan_failed',
          bucket_kind: 'staging',
          scan_engine: process.env.SCANNER_ENGINE ?? 'basic',
          scan_finished_at: scanFinishedAt,
          scan_reason: reason,
          quarantine_key: null,
        })
        .where('id', '=', artifactId)
        .execute();
      throw new Error(reason);
    }

    // Permanent failure: move to quarantine and block.
    await s3Client().send(
      new CopyObjectCommand({
        Bucket: quarantineBucket,
        Key: row.storage_key,
        CopySource: `${stagingBucket}/${row.storage_key}`,
        ContentType: row.content_type ?? undefined,
        MetadataDirective: 'COPY',
      })
    );
    await s3Client().send(new DeleteObjectCommand({ Bucket: stagingBucket, Key: row.storage_key }));

    await db
      .updateTable('artifacts')
      .set({
        status: 'blocked',
        bucket_kind: 'quarantine',
        scan_engine: process.env.SCANNER_ENGINE ?? 'basic',
        scan_finished_at: scanFinishedAt,
        scan_reason: reason,
        quarantine_key: row.storage_key,
      })
      .where('id', '=', artifactId)
      .execute();
    throw new Error(reason);
  }

  // Local backend: just mark scanned.
  if (!scan.ok) {
    const reason = scan.reason ?? 'scan_failed';
    const deterministicBlock = isDeterministicBlockReason(reason);
    const scannerError = isScannerErrorReason(reason);

    // Retryable scan engine error: keep the object and retry.
    if (!deterministicBlock && scannerError) {
      await db
        .updateTable('artifacts')
        .set({ status: 'scan_failed', scan_engine: process.env.SCANNER_ENGINE ?? 'basic', scan_finished_at: scanFinishedAt, scan_reason: reason })
        .where('id', '=', artifactId)
        .execute();
      throw new Error(reason);
    }

    await deleteStorageObject(row.storage_key);
    await db
      .updateTable('artifacts')
      .set({ status: 'blocked', scan_engine: process.env.SCANNER_ENGINE ?? 'basic', scan_finished_at: scanFinishedAt, scan_reason: reason })
      .where('id', '=', artifactId)
      .execute();
    throw new Error(reason);
  }

  await db
    .updateTable('artifacts')
    .set({ status: 'scanned', scan_engine: process.env.SCANNER_ENGINE ?? 'basic', scan_finished_at: scanFinishedAt, scan_reason: null })
    .where('id', '=', artifactId)
    .execute();
}

export async function deleteArtifactObject(artifactId: string) {
  const row = await db.selectFrom('artifacts').selectAll().where('id', '=', artifactId).executeTakeFirst();
  if (!row) return;
  if (row.deleted_at) return;

  const storageKey = row.storage_key;
  if (storageKey) {
    if (STORAGE_BACKEND === 'local') {
      const { filePath } = localPathForStorageKey(storageKey);
      await unlink(filePath).catch(() => undefined);
    } else if (STORAGE_BACKEND === 's3') {
      const kind = (row as any).bucket_kind as BucketKind | null;
      const bucket = bucketForKind(kind ?? 'staging');
      await s3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }));
    }
  }

  await db.updateTable('artifacts').set({ status: 'deleted', deleted_at: new Date() }).where('id', '=', artifactId).execute();
}
