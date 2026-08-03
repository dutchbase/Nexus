CREATE OR REPLACE FUNCTION validate_artifact_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.artifact_type='upload' THEN
    IF NEW.upload_id IS NULL OR NEW.agent_run_id IS NOT NULL OR NEW.execution_attempt_id IS NOT NULL THEN
      RAISE EXCEPTION USING MESSAGE = $msg$upload artifacts require only an upload owner$msg$;
    END IF;
  ELSIF NEW.artifact_type='execution_log' THEN
    -- A run log belongs permanently to the run that produced it. Execution
    -- attempts may later be repaired and repointed at another run.
    IF NEW.upload_id IS NOT NULL OR NEW.agent_run_id IS NULL THEN
      RAISE EXCEPTION USING MESSAGE = $msg$execution logs require only a run owner$msg$;
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

-- Legacy logs were already constrained to a controlled logs/<run-id>.log
-- location. Register only that derived location; metadata is never used as a
-- filesystem path. Worker reconciliation finalizes a present file or abandons
-- a missing one.
INSERT INTO artifacts (id, storage_path, artifact_type, status, expires_at, agent_run_id)
SELECT gen_random_uuid(), 'logs/' || ar.id::text || '.log', 'execution_log', 'staged', now() + interval '1 day', ar.id
FROM agent_runs ar
WHERE (ar.metadata_json->>'log_path') ~ ('(^|/)logs/' || ar.id::text || '\.log$')
  AND NOT EXISTS (
    SELECT 1 FROM artifacts a
    WHERE a.agent_run_id=ar.id AND a.artifact_type='execution_log'
  )
ON CONFLICT (storage_path) DO NOTHING;
