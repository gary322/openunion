-- GitHub intelligence core tables:
-- - ingestion sources/cursors
-- - raw events (append-only, replay-safe)
-- - normalized repo snapshots (for similarity and filtering)
-- - similarity query/result cache (skill-facing)
-- - provenance manifests (compliance + audit)

CREATE TABLE IF NOT EXISTS github_sources (
  id TEXT PRIMARY KEY,
  cursor_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),
  last_success_at TIMESTAMPTZ NULL,
  last_error_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_github_sources_status ON github_sources(status);

-- Raw GitHub events. `event_id` is globally unique across sources, so we use it as the primary key.
-- `sources_json` is a best-effort record of which ingesters observed the event (events_api, gh_archive, etc).
CREATE TABLE IF NOT EXISTS github_events_raw (
  event_id TEXT PRIMARY KEY,
  sources_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  event_type TEXT NOT NULL,
  event_created_at TIMESTAMPTZ NULL,
  repo_full_name TEXT NULL,
  actor_login TEXT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_github_events_raw_repo_created ON github_events_raw(repo_full_name, event_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_github_events_raw_ingested_at ON github_events_raw(ingested_at DESC);

-- Normalized repository snapshots. This is not a full mirror, only the fields needed for ranking/policy.
CREATE TABLE IF NOT EXISTS github_repos (
  repo_id BIGINT PRIMARY KEY,
  full_name TEXT NOT NULL,
  html_url TEXT NOT NULL,
  description TEXT NULL,
  language TEXT NULL,
  topics_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  license_spdx TEXT NULL,
  license_key TEXT NULL,
  stargazers_count INTEGER NOT NULL DEFAULT 0,
  forks_count INTEGER NOT NULL DEFAULT 0,
  archived BOOLEAN NOT NULL DEFAULT false,
  pushed_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_github_repos_full_name ON github_repos(full_name);
CREATE INDEX IF NOT EXISTS idx_github_repos_last_seen_at ON github_repos(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_github_repos_stars ON github_repos(stargazers_count DESC);

-- Similarity query cache (skill-facing). Results are stored separately for auditing and replay.
CREATE TABLE IF NOT EXISTS intel_similarity_queries (
  id TEXT PRIMARY KEY,
  tool TEXT NULL, -- codex|claude|api|internal
  org_id TEXT NULL REFERENCES orgs(id) ON DELETE SET NULL,
  actor_type TEXT NULL,
  actor_id TEXT NULL,
  query_text TEXT NOT NULL,
  context_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy_version TEXT NULL,
  latency_ms INTEGER NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_intel_similarity_queries_created_at ON intel_similarity_queries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intel_similarity_queries_org_created_at ON intel_similarity_queries(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS intel_similarity_results (
  id TEXT PRIMARY KEY,
  query_id TEXT NOT NULL REFERENCES intel_similarity_queries(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('repo', 'file', 'other')),
  item_key TEXT NOT NULL, -- e.g. "repo:owner/name" or "file:owner/name:path@sha"
  score DOUBLE PRECISION NOT NULL DEFAULT 0,
  explanation TEXT NULL,
  data_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_intel_similarity_results_query_rank ON intel_similarity_results(query_id, rank);
CREATE INDEX IF NOT EXISTS idx_intel_similarity_results_query_id ON intel_similarity_results(query_id);
CREATE INDEX IF NOT EXISTS idx_intel_similarity_results_item_key ON intel_similarity_results(item_key);

-- Provenance manifests: stable audit trail and attribution for any suggestion/reuse output.
CREATE TABLE IF NOT EXISTS intel_provenance_manifests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL, -- similarity_query|reuse_plan|other
  ref_id TEXT NOT NULL,
  manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_intel_provenance_kind_ref ON intel_provenance_manifests(kind, ref_id);
CREATE INDEX IF NOT EXISTS idx_intel_provenance_created_at ON intel_provenance_manifests(created_at DESC);
