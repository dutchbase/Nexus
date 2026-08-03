DROP TRIGGER IF EXISTS execution_attempt_worktree_owner ON execution_attempts;
DROP FUNCTION IF EXISTS repoint_execution_worktree_owner();

CREATE OR REPLACE FUNCTION reject_artifact_identity_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.storage_path IS DISTINCT FROM NEW.storage_path
    OR OLD.storage_root IS DISTINCT FROM NEW.storage_root
    OR OLD.artifact_type IS DISTINCT FROM NEW.artifact_type
    OR OLD.upload_id IS DISTINCT FROM NEW.upload_id
    OR OLD.agent_run_id IS DISTINCT FROM NEW.agent_run_id
    OR OLD.execution_attempt_id IS DISTINCT FROM NEW.execution_attempt_id THEN
    RAISE EXCEPTION USING MESSAGE = $msg$artifact identity and owner are immutable$msg$;
  END IF;
  RETURN NEW;
END;
$$;

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
    IF NEW.upload_id IS NOT NULL OR NEW.agent_run_id IS NULL
      OR (TG_OP='INSERT' AND NEW.execution_attempt_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM execution_attempts WHERE id=NEW.execution_attempt_id AND agent_run_id=NEW.agent_run_id)) THEN
      RAISE EXCEPTION 'execution logs require a matching run owner';
    END IF;
  ELSIF NEW.upload_id IS NOT NULL OR NEW.agent_run_id IS NULL OR NEW.execution_attempt_id IS NULL
    OR (TG_OP='INSERT' AND NOT EXISTS (SELECT 1 FROM execution_attempts WHERE id=NEW.execution_attempt_id AND agent_run_id=NEW.agent_run_id)) THEN
    RAISE EXCEPTION 'worktree artifacts require matching run and execution attempt owners';
  END IF;
  IF TG_OP='UPDATE' AND (OLD.status='abandoned' AND NEW.status<>'abandoned' OR OLD.status='finalized' AND NEW.status='staged') THEN
    RAISE EXCEPTION 'artifact lifecycle cannot move backward';
  END IF;
  RETURN NEW;
END;
$$;

-- Pre-artifact uploads and worktrees are registered only when their existing
-- generated paths identify the owner without trusting arbitrary metadata.
INSERT INTO artifacts (id,storage_path,storage_root,artifact_type,status,expires_at,upload_id)
SELECT gen_random_uuid(),
       substring(u.storage_path FROM '(uploads/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg))$'),
       'primary','upload','staged',now() + interval '1 day',u.id
FROM uploads u
WHERE u.storage_path ~ '(^|/)uploads/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg)$'
  AND NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.upload_id=u.id);

INSERT INTO artifacts (id,storage_path,storage_root,artifact_type,status,sha256,finalized_at,agent_run_id,execution_attempt_id)
SELECT gen_random_uuid(),
       substring(ea.worktree_path FROM '(worktrees/[A-Za-z0-9-]{1,64}/[A-Za-z0-9-]{1,64}/[0-9]+)$'),
       'legacy','worktree','finalized',
       encode(digest(COALESCE(ea.result_commit,ea.base_commit,ea.worktree_path),'sha256'),'hex'),
       now(),ea.agent_run_id,ea.id
FROM execution_attempts ea
WHERE ea.agent_run_id IS NOT NULL
  AND ea.worktree_path ~ '(^|/)data/worktrees/[A-Za-z0-9-]{1,64}/[A-Za-z0-9-]{1,64}/[0-9]+$'
  AND NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.execution_attempt_id=ea.id AND a.artifact_type='worktree');
