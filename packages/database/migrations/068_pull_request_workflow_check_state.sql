ALTER TABLE pull_requests
  ADD COLUMN workflow_check_state text NOT NULL DEFAULT 'none'
  CHECK (workflow_check_state IN ('none','in_progress','success','failure'));
