CREATE TABLE pull_request_policy_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pull_request_id uuid NOT NULL REFERENCES pull_requests(id) ON DELETE RESTRICT,
  material_json jsonb NOT NULL,
  material_hash text NOT NULL CHECK (material_hash ~ '^[0-9a-f]{64}$'),
  head_sha text NOT NULL,
  base_ref text NOT NULL,
  base_sha text,
  review_state text NOT NULL CHECK (review_state IN ('approved','changes_requested','pending','not_required','unknown')),
  check_state text NOT NULL CHECK (check_state IN ('success','failure','pending','not_required','unknown')),
  refusal_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(refusal_codes) = 'array'),
  complete boolean NOT NULL,
  incomplete_reason text,
  source text NOT NULL CHECK (source IN ('github')),
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (complete OR incomplete_reason IS NOT NULL)
);
CREATE INDEX pull_request_policy_snapshots_pr_fetched_idx
  ON pull_request_policy_snapshots (pull_request_id, fetched_at DESC);

CREATE FUNCTION verify_pull_request_policy_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.material_hash <> encode(digest(canonical_jsonb(NEW.material_json), 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'pull request policy snapshot hash does not match canonical material';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pull_request_policy_snapshots_verify
BEFORE INSERT ON pull_request_policy_snapshots
FOR EACH ROW EXECUTE FUNCTION verify_pull_request_policy_snapshot();

CREATE FUNCTION reject_pull_request_policy_snapshot_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pull request policy snapshots are immutable';
END;
$$;
CREATE TRIGGER pull_request_policy_snapshots_immutable
BEFORE UPDATE OR DELETE ON pull_request_policy_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_pull_request_policy_snapshot_mutation();

ALTER TABLE pull_requests
  ADD COLUMN current_policy_snapshot_id uuid REFERENCES pull_request_policy_snapshots(id) ON DELETE RESTRICT,
  ADD COLUMN policy_synced_at timestamptz,
  ADD COLUMN policy_last_attempted_at timestamptz,
  ADD COLUMN policy_complete boolean,
  ADD COLUMN policy_stale boolean NOT NULL DEFAULT true,
  ADD COLUMN policy_error_code text,
  ADD COLUMN policy_retry_after timestamptz,
  ADD COLUMN policy_sync_token uuid;

CREATE TABLE github_repository_sync_state (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  cursor text,
  complete boolean NOT NULL DEFAULT false,
  last_attempted_at timestamptz NOT NULL,
  last_completed_at timestamptz,
  error_code text,
  retry_after timestamptz
);
