-- packages/database/migrations/059_va_jobs_platform_project.sql
-- Idempotent upsert: if a va-jobs-platform project row already exists (by
-- slug), only its config_json.deployment block is set/merged — its
-- repository_path, name, and any other admin-configured fields are left
-- untouched. If no row exists, one is created with placeholder
-- repository_path/agent_start_path that must be filled in with a real local
-- clone path before planning/execution features (not this deployment
-- feature, which reads production/master SHAs live from the GitHub API, not
-- from a local clone) are used for this project.
INSERT INTO projects (id, slug, name, github_owner, github_repository, default_branch, repository_path, config_json, health_status)
VALUES (
  gen_random_uuid(), 'va-jobs-platform', 'VA Jobs Platform', 'dutchbase', 'va-jobs-platform', 'master',
  '/PLACEHOLDER/set-a-real-local-clone-path-for-va-jobs-platform',
  jsonb_build_object(
    'deployment', jsonb_build_object(
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
  ),
  'unknown'
)
ON CONFLICT (slug) DO UPDATE SET
  config_json = projects.config_json || jsonb_build_object(
    'deployment', jsonb_build_object(
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
  ),
  github_owner = 'dutchbase', github_repository = 'va-jobs-platform', default_branch = 'master';
