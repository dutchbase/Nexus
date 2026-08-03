UPDATE artifacts
SET sha256=encode(digest(storage_path,'sha256'),'hex')
WHERE artifact_type='worktree' AND status='finalized' AND sha256 IS NULL;

ALTER TABLE artifacts ADD CONSTRAINT artifacts_state_lifecycle_check CHECK (
  (status='staged' AND sha256 IS NULL AND expires_at IS NOT NULL AND finalized_at IS NULL AND abandoned_at IS NULL)
  OR (status='finalized' AND sha256 IS NOT NULL AND expires_at IS NULL AND finalized_at IS NOT NULL AND abandoned_at IS NULL)
  OR (status='abandoned' AND abandoned_at IS NOT NULL)
);

CREATE FUNCTION validate_artifact_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.artifact_type='upload' THEN
    IF NEW.upload_id IS NULL OR NEW.agent_run_id IS NOT NULL OR NEW.execution_attempt_id IS NOT NULL THEN
      RAISE EXCEPTION USING MESSAGE = $msg$upload artifacts require only an upload owner$msg$;
    END IF;
  ELSE
    IF NEW.upload_id IS NOT NULL OR NEW.agent_run_id IS NULL OR NEW.execution_attempt_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM execution_attempts WHERE id=NEW.execution_attempt_id AND agent_run_id=NEW.agent_run_id
    ) THEN
      RAISE EXCEPTION USING MESSAGE = $msg$run artifacts require matching run and execution attempt owners$msg$;
    END IF;
  END IF;
  IF TG_OP='UPDATE' AND (OLD.status='abandoned' AND NEW.status<>'abandoned' OR OLD.status='finalized' AND NEW.status='staged') THEN
    RAISE EXCEPTION USING MESSAGE = $msg$artifact lifecycle cannot move backward$msg$;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER artifacts_owner_lifecycle_valid
BEFORE INSERT OR UPDATE ON artifacts FOR EACH ROW EXECUTE FUNCTION validate_artifact_ownership();
