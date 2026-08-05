CREATE TABLE deployment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id text NOT NULL UNIQUE CHECK (length(btrim(delivery_id)) > 0),
  event_type text NOT NULL CHECK (event_type IN ('push', 'check_run')),
  target_ref text NOT NULL,
  target_sha text NOT NULL CHECK (target_sha ~ '^[0-9a-f]{40}$'),
  protected_branch text NOT NULL,
  protected_head_sha text NOT NULL CHECK (protected_head_sha ~ '^[0-9a-f]{40}$'),
  check_evidence jsonb NOT NULL CHECK (jsonb_typeof(check_evidence) = 'object'),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('rejected', 'queued', 'running', 'succeeded', 'failed', 'blocked')),
  owner text,
  lease_expires_at timestamptz,
  recovery_count integer NOT NULL DEFAULT 0 CHECK (recovery_count BETWEEN 0 AND 1),
  recovery_reason text,
  marker_path text,
  prior_release_path text,
  notification_status text CHECK (notification_status IN ('accepted', 'failed_http', 'failed_network', 'disabled_config')),
  notification_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (protected_branch, target_sha),
  CHECK ((state = 'running') = (owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (state NOT IN ('succeeded', 'failed', 'blocked') OR completed_at IS NOT NULL)
);

CREATE UNIQUE INDEX deployment_attempts_one_running_idx
  ON deployment_attempts ((state)) WHERE state = 'running';

CREATE INDEX deployment_attempts_queue_idx
  ON deployment_attempts (queued_at, created_at) WHERE state = 'queued';

CREATE TABLE deployment_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES deployment_attempts(id),
  event_key text NOT NULL,
  event_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(metadata) = 'object'
    AND NOT (metadata ?| ARRAY['authorization', 'token', 'secret', 'recipient', 'body', 'payload', 'webhook_body', 'response_body'])
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, event_key)
);

CREATE OR REPLACE FUNCTION reject_deployment_attempt_identity_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
    OR NEW.event_type IS DISTINCT FROM OLD.event_type
    OR NEW.target_ref IS DISTINCT FROM OLD.target_ref
    OR NEW.target_sha IS DISTINCT FROM OLD.target_sha
    OR NEW.protected_branch IS DISTINCT FROM OLD.protected_branch
    OR NEW.protected_head_sha IS DISTINCT FROM OLD.protected_head_sha
    OR NEW.check_evidence IS DISTINCT FROM OLD.check_evidence THEN
    RAISE EXCEPTION 'deployment attempt identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER deployment_attempts_identity_immutable
  BEFORE UPDATE ON deployment_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_deployment_attempt_identity_change();

CREATE OR REPLACE FUNCTION reject_deployment_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'deployment events are append-only';
END;
$$;

CREATE TRIGGER deployment_events_append_only
  BEFORE UPDATE OR DELETE ON deployment_events
  FOR EACH ROW EXECUTE FUNCTION reject_deployment_event_mutation();
