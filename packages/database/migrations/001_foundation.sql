CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'admin',
  is_active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  csrf_token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE login_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL,
  succeeded boolean NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_username_time_idx ON login_attempts (username, attempted_at DESC);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  enabled boolean NOT NULL DEFAULT true,
  repository_path text NOT NULL,
  github_owner text,
  github_repository text,
  default_branch text NOT NULL DEFAULT 'main',
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  config_version integer NOT NULL DEFAULT 1,
  health_status text NOT NULL DEFAULT 'unknown',
  last_validated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_config_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version integer NOT NULL,
  content_yaml text NOT NULL,
  content_hash text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  priority text NOT NULL DEFAULT 'normal',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  attempt integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  available_at timestamptz,
  claimed_at timestamptz,
  claimed_by text,
  completed_at timestamptz,
  error_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key)
);
CREATE INDEX jobs_claim_idx ON jobs (status, available_at, created_at);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type text NOT NULL,
  actor_id uuid,
  action text NOT NULL,
  entity_type text,
  entity_id uuid,
  before_json jsonb,
  after_json jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The frozen fixture loader inserts representative later-phase rows in a
-- single transaction. These exact PRD §26 shapes are declared now solely so
-- Phase 1 authentication and operational tests can bootstrap their fixtures;
-- no later-phase behavior is implemented here.
CREATE TABLE forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, slug text NOT NULL UNIQUE,
  title text NOT NULL, description text, status text NOT NULL, fixed_project_id uuid REFERENCES projects(id),
  settings_json jsonb NOT NULL DEFAULT '{}'::jsonb, published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE, name text NOT NULL,
  description text, category text, source_type text, filesystem_path text, enabled boolean NOT NULL DEFAULT true,
  risk_level text, version text, content_hash text, configuration_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE project_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects(id),
  skill_id uuid NOT NULL REFERENCES skills(id), attachment_type text NOT NULL, required boolean NOT NULL DEFAULT false,
  allow_ticket_override boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_number text NOT NULL UNIQUE,
  form_id uuid REFERENCES forms(id), project_id uuid NOT NULL REFERENCES projects(id), title text NOT NULL,
  description text, category text, priority text, status text NOT NULL, submitter_name text, submitter_email text,
  source_url text, environment text, expected_behavior text, actual_behavior text, reproduction_steps text,
  custom_values_json jsonb NOT NULL DEFAULT '{}'::jsonb, ai_configuration_mode text, default_model text,
  default_reasoning_level text, planning_model text, planning_reasoning_level text, execution_model text,
  execution_reasoning_level text, repair_model text, repair_reasoning_level text,
  approved_plan_version_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pull_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid REFERENCES projects(id),
  ticket_id uuid REFERENCES tickets(id), execution_attempt_id uuid, provider text, repository text, number integer,
  url text, title text, author text, state text, review_state text, check_state text, is_draft boolean,
  head_branch text, base_branch text, head_sha text, merge_commit_sha text, created_at_provider timestamptz,
  updated_at_provider timestamptz, merged_at timestamptz, closed_at timestamptz, last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id uuid REFERENCES tickets(id),
  project_id uuid REFERENCES projects(id), run_type text, status text, claude_session_id text, model text,
  reasoning_level text, working_directory text, prompt_snapshot_id uuid, skill_snapshot_id uuid,
  started_at timestamptz, finished_at timestamptz, exit_code integer, error_code text, error_message text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE notification_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, type text NOT NULL,
  enabled boolean NOT NULL DEFAULT true, configuration_encrypted_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider_id uuid REFERENCES notification_providers(id),
  event_type text, ticket_id uuid REFERENCES tickets(id), project_id uuid REFERENCES projects(id), run_id uuid,
  pull_request_id uuid REFERENCES pull_requests(id), idempotency_key text UNIQUE, payload_json jsonb,
  status text, attempt_count integer, response_status integer, error_message text, sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
