CREATE OR REPLACE FUNCTION validate_artifact_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.artifact_type='upload' THEN
    IF NEW.upload_id IS NULL OR NEW.agent_run_id IS NOT NULL OR NEW.execution_attempt_id IS NOT NULL THEN RAISE EXCEPTION 'upload artifacts require only an upload owner'; END IF;
  ELSIF NEW.artifact_type='conflict_worktree' THEN
    IF NEW.upload_id IS NOT NULL OR NEW.execution_attempt_id IS NOT NULL OR NEW.agent_run_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM agent_runs ar JOIN pr_conflict_resolutions pcr ON pcr.agent_run_id=ar.id
      WHERE ar.id=NEW.agent_run_id AND ar.run_type='pr_conflict_resolution'
    ) THEN RAISE EXCEPTION 'conflict worktrees require their conflict-resolution run owner'; END IF;
  ELSIF NEW.artifact_type='execution_log' THEN
    IF NEW.upload_id IS NOT NULL OR NEW.agent_run_id IS NULL THEN RAISE EXCEPTION 'execution logs require a run owner'; END IF;
  ELSIF NEW.upload_id IS NOT NULL OR NEW.agent_run_id IS NULL OR NEW.execution_attempt_id IS NULL OR NOT EXISTS (SELECT 1 FROM execution_attempts WHERE id=NEW.execution_attempt_id AND agent_run_id=NEW.agent_run_id) THEN RAISE EXCEPTION 'worktree artifacts require matching run and execution attempt owners';
  END IF;
  IF TG_OP='UPDATE' AND (OLD.status='abandoned' AND NEW.status<>'abandoned' OR OLD.status='finalized' AND NEW.status='staged') THEN RAISE EXCEPTION 'artifact lifecycle cannot move backward'; END IF;
  RETURN NEW;
END;
$$;
