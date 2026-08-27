-- packages/database/migrations/060_supersede_stale_deployment_attempts.sql
-- Adds a 'superseded' terminal state so the deployment queue can coalesce
-- to the latest push instead of chasing every stale SHA in a burst of
-- rapid merges (each older attempt would otherwise fail deploy.sh's
-- fetched-head-must-match-target-sha guard one by one).

ALTER TABLE deployment_attempts DROP CONSTRAINT deployment_attempts_state_check;
ALTER TABLE deployment_attempts ADD CONSTRAINT deployment_attempts_state_check
  CHECK (state IN ('rejected', 'queued', 'running', 'succeeded', 'failed', 'blocked', 'superseded'));

ALTER TABLE deployment_attempts DROP CONSTRAINT deployment_attempts_check1;
ALTER TABLE deployment_attempts ADD CONSTRAINT deployment_attempts_check1
  CHECK (state NOT IN ('succeeded', 'failed', 'blocked', 'superseded') OR completed_at IS NOT NULL);
