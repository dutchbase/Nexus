-- packages/database/migrations/058_production_promotion_actions_tracking.sql
-- Additive columns for the github_actions_jobs deployment mechanism. All
-- nullable/defaulted so rows for projects using the existing "health_check"
-- mechanism are never populated and existing reads are unaffected.

ALTER TABLE deployment_status_snapshots
  ADD COLUMN master_workflow_run_id bigint,
  ADD COLUMN master_workflow_conclusion text,
  ADD COLUMN docker_image_job_conclusion text,
  ADD COLUMN ghcr_checked boolean NOT NULL DEFAULT false,
  ADD COLUMN ghcr_verified boolean,
  ADD COLUMN divergence text CHECK (divergence IN ('up_to_date','behind_master','diverged','unavailable')),
  ADD COLUMN production_workflow_run_id bigint,
  ADD COLUMN production_workflow_conclusion text,
  ADD COLUMN migrations_job_conclusion text,
  ADD COLUMN deploy_job_conclusion text;

ALTER TABLE production_releases
  ADD COLUMN forced boolean NOT NULL DEFAULT false,
  -- Set true only when the ref-update failure was specifically classified as
  -- a 422 non-fast-forward (see Task 4) — lets the UI distinguish "diverged,
  -- needs the force-recovery flow" from any other ref_update_failed cause
  -- (401/403/network/rate-limit) without widening the `status` CHECK.
  ADD COLUMN non_fast_forward boolean NOT NULL DEFAULT false,
  ADD COLUMN production_workflow_run_id bigint;
