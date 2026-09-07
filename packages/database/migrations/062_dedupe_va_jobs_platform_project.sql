-- Correct the original instance-specific migration before it runs anywhere
-- pending: the old body named two production UUIDs and could not unblock a
-- fresh or differently seeded installation. Historical rows remain attached
-- to the retired project because several of them are append-only.
DO $$
DECLARE
  duplicate_group record;
  survivor_id uuid;
BEGIN
  FOR duplicate_group IN
    SELECT lower(github_owner) owner_key, lower(github_repository) repository_key
    FROM projects
    WHERE github_owner IS NOT NULL AND github_repository IS NOT NULL
    GROUP BY lower(github_owner), lower(github_repository)
    HAVING count(*) > 1
  LOOP
    SELECT id INTO survivor_id
    FROM projects
    WHERE lower(github_owner)=duplicate_group.owner_key
      AND lower(github_repository)=duplicate_group.repository_key
    ORDER BY (
      repository_path IS NOT NULL AND btrim(repository_path) <> ''
      AND btrim(repository_path) NOT ILIKE '/PLACEHOLDER/%'
    ) DESC, enabled DESC, created_at, id
    LIMIT 1;

    UPDATE projects
    SET enabled=false,
        github_owner=NULL,
        github_repository=NULL,
        config_json=config_json || jsonb_build_object(
          '_migration_062_repository_deduplication',
          jsonb_build_object(
            'survivor_project_id', survivor_id,
            'github_owner', duplicate_group.owner_key,
            'github_repository', duplicate_group.repository_key
          )
        ),
        updated_at=now()
    WHERE id <> survivor_id
      AND lower(github_owner)=duplicate_group.owner_key
      AND lower(github_repository)=duplicate_group.repository_key;
  END LOOP;
END $$;

DROP INDEX IF EXISTS projects_github_repo_unique;
CREATE UNIQUE INDEX projects_github_repo_unique
  ON projects (lower(github_owner), lower(github_repository))
  WHERE github_owner IS NOT NULL AND github_repository IS NOT NULL;
