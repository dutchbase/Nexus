CREATE TABLE artifacts (
  id uuid PRIMARY KEY,
  storage_path text NOT NULL UNIQUE,
  artifact_type text NOT NULL CHECK (artifact_type IN ('upload','execution_log','worktree')),
  status text NOT NULL CHECK (status IN ('staged','finalized','abandoned')),
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz,
  finalized_at timestamptz,
  abandoned_at timestamptz,
  upload_id uuid UNIQUE REFERENCES uploads(id) ON DELETE RESTRICT,
  agent_run_id uuid REFERENCES agent_runs(id) ON DELETE RESTRICT,
  execution_attempt_id uuid REFERENCES execution_attempts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'finalized' OR (finalized_at IS NOT NULL AND (artifact_type='worktree' OR sha256 IS NOT NULL)))
);

CREATE INDEX artifacts_agent_run_idx ON artifacts (agent_run_id) WHERE status='finalized';
CREATE INDEX artifacts_execution_attempt_idx ON artifacts (execution_attempt_id) WHERE status='finalized';

CREATE FUNCTION reject_artifact_identity_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id OR OLD.storage_path IS DISTINCT FROM NEW.storage_path OR OLD.artifact_type IS DISTINCT FROM NEW.artifact_type THEN
    RAISE EXCEPTION USING MESSAGE = $msg$artifact identity is immutable$msg$;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER artifacts_identity_immutable
BEFORE UPDATE ON artifacts FOR EACH ROW EXECUTE FUNCTION reject_artifact_identity_change();
