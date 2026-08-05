ALTER TABLE deployment_attempts
  DROP CONSTRAINT deployment_attempts_protected_branch_target_sha_key;

CREATE UNIQUE INDEX deployment_attempts_active_sha_idx
  ON deployment_attempts (protected_branch, target_sha)
  WHERE state <> 'rejected';
