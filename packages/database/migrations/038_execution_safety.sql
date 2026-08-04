ALTER TABLE execution_attempts
  ADD COLUMN source_execution_attempt_id uuid REFERENCES execution_attempts(id) ON DELETE RESTRICT,
  ADD COLUMN worktree_lifecycle_status text NOT NULL DEFAULT 'active' CHECK (worktree_lifecycle_status IN ('active', 'reclaimed')),
  ADD COLUMN worktree_expires_at timestamptz,
  ADD COLUMN worktree_reclaimed_at timestamptz;

UPDATE execution_attempts
SET worktree_expires_at = now() + interval '1 day'
WHERE worktree_path IS NOT NULL
  AND worktree_expires_at IS NULL
  AND validation_status IN ('completed','published','failed','pr_creation_failed','cancelled','timed_out');

CREATE INDEX execution_attempts_worktree_reaper_idx
  ON execution_attempts (worktree_expires_at)
  WHERE worktree_lifecycle_status='active' AND worktree_expires_at IS NOT NULL;

CREATE FUNCTION expire_execution_worktree() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.worktree_path IS NOT NULL
     AND OLD.worktree_expires_at IS NULL
     AND NEW.validation_status IN ('completed','published','failed','pr_creation_failed','cancelled','timed_out') THEN
    NEW.worktree_expires_at := now() + interval '1 day';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER execution_attempt_worktree_expiry
BEFORE UPDATE OF validation_status ON execution_attempts
FOR EACH ROW EXECUTE FUNCTION expire_execution_worktree();
