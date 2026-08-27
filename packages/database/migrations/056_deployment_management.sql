-- packages/database/migrations/056_deployment_management.sql

CREATE TABLE deployment_status_snapshots (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  master_commit_sha text CHECK (master_commit_sha ~ '^[0-9a-f]{40}$'),
  master_ci_state text CHECK (master_ci_state IN ('success','failure','pending','none','unknown')),
  master_ci_checked_at timestamptz,
  e2e_gate_satisfied boolean,
  e2e_gate_pr_number integer,
  image_tag text,
  image_exists boolean,
  image_checked_at timestamptz,
  production_commit_sha text CHECK (production_commit_sha ~ '^[0-9a-f]{40}$'),
  production_health text CHECK (production_health IN ('healthy','unhealthy','unreachable','unknown')),
  production_version_raw jsonb,
  production_checked_at timestamptz,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  error_json jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE production_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('promote','rollback')),
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  previous_commit_sha text CHECK (previous_commit_sha ~ '^[0-9a-f]{40}$'),
  image_tag text,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','pending_approval','deploying','healthy','failed','superseded')),
  triggered_by uuid REFERENCES users(id),
  job_id uuid REFERENCES jobs(id),
  health_checked_at timestamptz,
  health_detail_json jsonb,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX production_releases_project_created_idx ON production_releases (project_id, created_at DESC);

-- At most one in-flight release per project — this is the DB-level fix for
-- the "two browser tabs promote at once" race (Task 11's promote/rollback
-- handlers rely on the resulting unique-violation to refuse the second one).
CREATE UNIQUE INDEX production_releases_project_inflight_idx
  ON production_releases (project_id) WHERE status IN ('requested','pending_approval','deploying');

CREATE TABLE cron_check_ins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  route_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('success','failure')),
  duration_ms integer,
  detail_json jsonb,
  idempotency_key text,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX cron_check_ins_idempotency_idx ON cron_check_ins (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX cron_check_ins_project_route_idx ON cron_check_ins (project_id, route_key, received_at DESC);
