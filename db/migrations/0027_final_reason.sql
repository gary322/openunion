-- Add stable, buyer-visible failure reasons for jobs/submissions.
-- This is used by UX and remote smoke tests to explain why something failed without requiring admin/verifier access.

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS final_reason TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS final_reason TEXT;

-- Backfill submission.final_reason from the latest verification reason (if any).
WITH latest AS (
  SELECT DISTINCT ON (v.submission_id)
    v.submission_id,
    v.reason
  FROM verifications v
  WHERE v.reason IS NOT NULL
  ORDER BY v.submission_id, v.attempt_no DESC
)
UPDATE submissions s
SET final_reason = latest.reason
FROM latest
WHERE s.id = latest.submission_id
  AND s.final_reason IS NULL;

-- Backfill job.final_reason from its current submission (if present).
UPDATE jobs j
SET final_reason = s.final_reason
FROM submissions s
WHERE j.current_submission_id = s.id
  AND j.final_reason IS NULL
  AND s.final_reason IS NOT NULL;

