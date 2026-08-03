ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_artifact_type_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_artifact_type_check
  CHECK (artifact_type IN ('upload','execution_log','worktree','conflict_worktree'));

CREATE OR REPLACE FUNCTION validate_artifact_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.artifact_type='upload' THEN
    IF NEW.upload_id IS NULL OR NEW.agent_run_id IS NOT NULL OR NEW.execution_attempt_id IS NOT NULL THEN
      RAISE EXCEPTION USING MESSAGE = $msg$upload artifacts require only an upload owner$msg$;
    END IF;
  ELSIF NEW.artifact_type IN ('execution_log','conflict_worktree') THEN
    IF NEW.upload_id IS NOT NULL OR NEW.agent_run_id IS NULL THEN
      RAISE EXCEPTION USING MESSAGE = $msg$run artifacts require a run owner$msg$;
    END IF;
  ELSIF NEW.upload_id IS NOT NULL OR NEW.agent_run_id IS NULL OR NEW.execution_attempt_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM execution_attempts WHERE id=NEW.execution_attempt_id AND agent_run_id=NEW.agent_run_id
  ) THEN
    RAISE EXCEPTION USING MESSAGE = $msg$worktree artifacts require matching run and execution attempt owners$msg$;
  END IF;
  IF TG_OP='UPDATE' AND (OLD.status='abandoned' AND NEW.status<>'abandoned' OR OLD.status='finalized' AND NEW.status='staged') THEN
    RAISE EXCEPTION USING MESSAGE = $msg$artifact lifecycle cannot move backward$msg$;
  END IF;
  RETURN NEW;
END;
$$;
