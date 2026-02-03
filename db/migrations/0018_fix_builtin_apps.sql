-- Fix built-in app registry entries to match shipped /public/apps/* templates.
--
-- The shipped vertical app pages use these taskDescriptor.type values:
-- - marketplace_drops
-- - jobs_scrape
-- - arxiv_research_plan
--
-- Earlier seeds used placeholder task_type values; update them safely.

-- Remove conflicting rows if any (fresh installs shouldn't have them, but this keeps the migration idempotent).
DELETE FROM apps
WHERE task_type IN ('marketplace_drops', 'jobs_scrape', 'arxiv_research_plan')
  AND id NOT IN ('app_marketplace', 'app_jobs', 'app_research');

UPDATE apps SET task_type = 'marketplace_drops', updated_at = now() WHERE id = 'app_marketplace';
UPDATE apps SET task_type = 'jobs_scrape', updated_at = now() WHERE id = 'app_jobs';
UPDATE apps SET task_type = 'arxiv_research_plan', updated_at = now() WHERE id = 'app_research';

