#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[test_full] starting docker services (postgres+clamav+minio)..."
docker compose up -d postgres clamav minio minio-init

export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5433/proofwork}"
export CLAMD_HOST="${CLAMD_HOST:-127.0.0.1}"
export CLAMD_PORT="${CLAMD_PORT:-3310}"
export CLAMD_TIMEOUT_MS="${CLAMD_TIMEOUT_MS:-15000}"

export STORAGE_ENDPOINT="${STORAGE_ENDPOINT:-http://localhost:19100}"
export S3_REGION="${S3_REGION:-us-east-1}"
export S3_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-minioadmin}"
export S3_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-minioadmin}"
export S3_BUCKET_STAGING="${S3_BUCKET_STAGING:-proofwork-staging}"
export S3_BUCKET_CLEAN="${S3_BUCKET_CLEAN:-proofwork-clean}"
export S3_BUCKET_QUARANTINE="${S3_BUCKET_QUARANTINE:-proofwork-quarantine}"

echo "[test_full] DATABASE_URL=$DATABASE_URL"

echo "[test_full] vitest (default/local backend) + clamd + verifier Playwright harness..."
RUN_CLAMD_TESTS=1 RUN_PLAYWRIGHT_VERIFIER_TESTS=1 npm run test:serial

echo "[test_full] vitest (S3 backend) scan pipeline..."
RUN_S3_SCAN_TESTS=1 STORAGE_BACKEND=s3 npm run test:serial -- tests/s3_scan_pipeline.test.ts

echo "[test_full] Playwright UI E2E..."
CI=1 npm run test:e2e

echo "[test_full] OK"
