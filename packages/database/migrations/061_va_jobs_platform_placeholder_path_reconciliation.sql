-- packages/database/migrations/061_va_jobs_platform_placeholder_path_reconciliation.sql
--
-- Migration 059 seeded a project row for slug='va-jobs-platform' with a
-- placeholder repository_path, and deliberately never overwrites
-- repository_path on a slug conflict (see 059's own header comment). The
-- Production tab (apps/web/src/pages/merge.ts) and the production-promotion
-- allowlist (packages/domain/src/production-promotion-allowlist.ts) both
-- resolve this feature by that exact slug -- so if a *different*,
-- pre-existing project row already represented this same GitHub repository
-- (dutchbase/va-jobs-platform) under a different slug, with a real local
-- path already configured there, that real path never reached the row this
-- feature actually reads, and the placeholder survived indefinitely.
--
-- This is data reconciliation, not a schema change: only act when the
-- 'va-jobs-platform' row's repository_path is still literally the exact
-- placeholder string, and only when there is exactly one unambiguous
-- non-placeholder candidate row for the same repository -- copy that row's
-- repository_path (and agent_start_path, if the target doesn't already have
-- one) onto the 'va-jobs-platform' row. Never destructive: the source row is
-- left untouched, nothing is deleted, and an ambiguous (0 or 2+ candidates)
-- state is logged via RAISE NOTICE and left for manual resolution rather
-- than guessed at.
DO $$
DECLARE
  target_id uuid;
  source_id uuid;
  source_repository_path text;
  source_agent_start_path text;
  candidate_count integer;
BEGIN
  SELECT id INTO target_id FROM projects
    WHERE slug = 'va-jobs-platform'
      AND repository_path = '/PLACEHOLDER/set-a-real-local-clone-path-for-va-jobs-platform';

  IF target_id IS NULL THEN
    RAISE NOTICE 'va-jobs-platform: repository_path is not the known placeholder (already fixed, or row missing/renamed) -- nothing to reconcile.';
    RETURN;
  END IF;

  SELECT count(*) INTO candidate_count FROM projects
    WHERE github_owner = 'dutchbase' AND github_repository = 'va-jobs-platform'
      AND id != target_id
      AND repository_path IS NOT NULL
      AND btrim(repository_path) != ''
      AND repository_path NOT LIKE '/PLACEHOLDER/%';

  IF candidate_count = 1 THEN
    SELECT id, repository_path, agent_start_path INTO source_id, source_repository_path, source_agent_start_path
      FROM projects
      WHERE github_owner = 'dutchbase' AND github_repository = 'va-jobs-platform'
        AND id != target_id
        AND repository_path IS NOT NULL
        AND btrim(repository_path) != ''
        AND repository_path NOT LIKE '/PLACEHOLDER/%';

    UPDATE projects
      SET repository_path = source_repository_path,
          agent_start_path = COALESCE(agent_start_path, source_agent_start_path),
          config_version = config_version + 1,
          updated_at = now()
      WHERE id = target_id;

    RAISE NOTICE 'va-jobs-platform: copied repository_path from project % onto the va-jobs-platform project row (%).', source_id, target_id;
  ELSIF candidate_count = 0 THEN
    RAISE NOTICE 'va-jobs-platform: no other project row has a real repository_path configured for dutchbase/va-jobs-platform -- an admin must set "Local repository path" on the "VA Jobs Platform" project via the Projects page.';
  ELSE
    RAISE NOTICE 'va-jobs-platform: % candidate rows found with a real repository_path for dutchbase/va-jobs-platform -- ambiguous, left untouched. An admin must resolve which is correct via the Projects page.', candidate_count;
  END IF;
END $$;
