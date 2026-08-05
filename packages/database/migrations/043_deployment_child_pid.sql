ALTER TABLE deployment_attempts
  ADD COLUMN IF NOT EXISTS child_pid integer CHECK (child_pid IS NULL OR child_pid > 0);
