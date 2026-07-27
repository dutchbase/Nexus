-- Phase 8: one platform PR per execution attempt, with a real attempt FK.
ALTER TABLE pull_requests
  ADD CONSTRAINT pull_requests_execution_attempt_fk
  FOREIGN KEY (execution_attempt_id) REFERENCES execution_attempts(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX pull_requests_execution_attempt_unique
  ON pull_requests (execution_attempt_id)
  WHERE execution_attempt_id IS NOT NULL;
