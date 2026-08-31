-- packages/database/migrations/062_dedupe_va_jobs_platform_project.sql
--
-- Migration 059 tried to be idempotent by matching ON CONFLICT (slug =
-- 'va-jobs-platform'), but this instance already had the same GitHub repo
-- registered under a different slug ('jobs-platform', created manually
-- before migration 059 shipped). The ON CONFLICT never matched, so a second
-- `projects` row was inserted for the same repo. Every PR sync since then
-- has written each PR to both rows, so PRs show up twice on the PR page,
-- and PR AI review runs / deployment status tracking got split across the
-- two rows too.
--
-- This migration consolidates onto the original row (1294ba02-..., which
-- holds all the real merge history and audit trail). The duplicate
-- (f2c99305-...) and its 202 pull_requests rows cannot be deleted outright:
-- those PRs have 14k+ pull_request_policy_snapshots rows and the duplicate
-- project itself has 44 prompt_snapshots rows, and both
-- pull_request_policy_snapshots and prompt_snapshots are append-only by
-- design (see the *_immutable / *_append_only triggers in
-- 020_data_lifecycle.sql and 039_github_policy_snapshots.sql — UPDATE and
-- DELETE are both unconditionally rejected), with NOT NULL ... ON DELETE
-- RESTRICT references back to pull_requests/projects. So instead of
-- deleting anything, the duplicate project is de-fanged: unlinked from
-- GitHub, disabled, and its slug freed up so the surviving row can take it.
-- Its historical pull_requests/prompt_snapshots/policy-snapshot rows stay
-- in place forever to satisfy those immutable references; the PR page
-- query (apps/web/src/pages/prs.ts) is updated separately to only join
-- against enabled projects, so the disabled duplicate's PRs stop being
-- displayed without needing to be deleted.

-- 1. Merge the real deployment config onto the surviving row (deep-merge
--    just the "deployment" key so unrelated config like `commands` and
--    `branch_prefix` on the surviving row is untouched).
UPDATE projects SET
  config_json = jsonb_set(
    config_json,
    '{deployment}',
    COALESCE(config_json->'deployment', '{}'::jsonb) || jsonb_build_object(
      'enabled', true,
      'mechanism', 'github_actions_jobs',
      'production_branch', 'production',
      'image', jsonb_build_object('registry', 'ghcr.io', 'repository', 'dutchbase/va-jobs-platform', 'tag_template', 'sha-{{commit}}'),
      'promotion', jsonb_build_object('require_e2e_gate_label', false),
      'actions', jsonb_build_object(
        'docker_image_job_name', 'docker-image',
        'migrations_job_name', 'migrations-production',
        'deploy_job_name', 'deploy-production'
      )
    )
  )
WHERE id = '1294ba02-f1de-4324-8a4f-f9c2310de4c4';

-- 2. Move real live/historical data off the duplicate row for the tables
--    where that's actually possible (agent_runs and
--    deployment_status_snapshots are ordinary mutable tables, unlike
--    prompt_snapshots). No-ops safely if the duplicate row doesn't exist,
--    e.g. on a fresh test database.
UPDATE agent_runs SET project_id = '1294ba02-f1de-4324-8a4f-f9c2310de4c4'
  WHERE project_id = 'f2c99305-cb35-4cf5-b2a3-774b9492cdc6';
UPDATE deployment_status_snapshots SET project_id = '1294ba02-f1de-4324-8a4f-f9c2310de4c4'
  WHERE project_id = 'f2c99305-cb35-4cf5-b2a3-774b9492cdc6'
  AND NOT EXISTS (SELECT 1 FROM deployment_status_snapshots WHERE project_id = '1294ba02-f1de-4324-8a4f-f9c2310de4c4');

-- 3. Drop the duplicate's sync-state row (not append-only, and the
--    surviving project already has its own) so there's no leftover cursor
--    for a project that will no longer be synced.
DELETE FROM github_repository_sync_state WHERE project_id = 'f2c99305-cb35-4cf5-b2a3-774b9492cdc6';

-- 4. De-fang the duplicate row instead of deleting it, and free its slug.
--    Unlinking github_owner/github_repository stops the PR-sync job
--    (which selects `WHERE github_owner IS NOT NULL AND github_repository
--    IS NOT NULL`) from ever touching it again.
UPDATE projects SET
  enabled = false,
  github_owner = NULL,
  github_repository = NULL,
  slug = 'va-jobs-platform-retired-' || substr(id::text, 1, 8),
  name = name || ' (retired duplicate, superseded by 1294ba02-f1de-4324-8a4f-f9c2310de4c4)'
WHERE id = 'f2c99305-cb35-4cf5-b2a3-774b9492cdc6';

-- 5. Rename the surviving row to match the pre-existing security allowlist
--    entry in packages/domain/src/production-promotion-allowlist.ts, which
--    is keyed on slug 'va-jobs-platform'.
UPDATE projects SET slug = 'va-jobs-platform', name = 'VA Jobs Platform'
  WHERE id = '1294ba02-f1de-4324-8a4f-f9c2310de4c4';

-- 6. Stop a second *linked* project row for the same GitHub repo from ever
--    being created again (the retired row above has no github_owner/
--    github_repository, so it does not conflict with this index).
CREATE UNIQUE INDEX projects_github_repo_unique ON projects (github_owner, github_repository)
  WHERE github_owner IS NOT NULL AND github_repository IS NOT NULL;
