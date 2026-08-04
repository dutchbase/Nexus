CREATE TABLE pull_request_merge_attempts (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE RESTRICT,
  pull_request_id uuid NOT NULL REFERENCES pull_requests(id) ON DELETE RESTRICT,
  expected_policy_snapshot_id uuid NOT NULL REFERENCES pull_request_policy_snapshots(id) ON DELETE RESTRICT,
  verified_policy_snapshot_id uuid REFERENCES pull_request_policy_snapshots(id) ON DELETE RESTRICT,
  expected_head_sha text NOT NULL,
  merged_head_sha text,
  merged_sha text,
  state text NOT NULL CHECK (state IN ('verified','refused','merged')),
  refusal_code text,
  provider_response jsonb,
  actor_type text NOT NULL CHECK (actor_type IN ('worker','admin')),
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  refused_at timestamptz,
  merged_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'refused') = (refusal_code IS NOT NULL)),
  CHECK (state <> 'merged' OR (verified_policy_snapshot_id IS NOT NULL AND merged_head_sha IS NOT NULL AND merged_sha IS NOT NULL))
);
CREATE INDEX pull_request_merge_attempts_pr_created_idx
  ON pull_request_merge_attempts (pull_request_id, created_at DESC);
