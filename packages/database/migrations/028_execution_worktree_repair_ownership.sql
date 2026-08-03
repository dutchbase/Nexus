CREATE FUNCTION repoint_execution_worktree_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE artifacts SET agent_run_id=NEW.agent_run_id
  WHERE execution_attempt_id=NEW.id AND artifact_type='worktree';
  RETURN NEW;
END;
$$;

CREATE TRIGGER execution_attempt_worktree_owner
AFTER UPDATE OF agent_run_id ON execution_attempts
FOR EACH ROW
WHEN (OLD.agent_run_id IS DISTINCT FROM NEW.agent_run_id AND NEW.agent_run_id IS NOT NULL)
EXECUTE FUNCTION repoint_execution_worktree_owner();
