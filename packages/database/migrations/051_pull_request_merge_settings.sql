CREATE TABLE pull_request_merge_settings (
  id integer PRIMARY KEY CHECK (id = 1),
  require_fresh_policy_binding boolean NOT NULL DEFAULT false
);
INSERT INTO pull_request_merge_settings (id) VALUES (1);

ALTER TABLE pull_request_merge_attempts
  ALTER COLUMN expected_policy_snapshot_id DROP NOT NULL,
  DROP CONSTRAINT pull_request_merge_attempts_check2,
  ADD CONSTRAINT pull_request_merge_attempts_merged_sha_check
    CHECK (state <> 'merged' OR (merged_head_sha IS NOT NULL AND merged_sha IS NOT NULL));
