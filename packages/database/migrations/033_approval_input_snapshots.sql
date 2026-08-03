CREATE TABLE approved_input_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
  plan_version_id uuid NOT NULL REFERENCES plan_versions(id) ON DELETE RESTRICT,
  material_input_json jsonb NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approved_input_snapshots_ticket_created_idx
  ON approved_input_snapshots (ticket_id, created_at DESC);

CREATE TABLE plan_approval_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
  plan_version_id uuid NOT NULL REFERENCES plan_versions(id) ON DELETE RESTRICT,
  approved_input_snapshot_id uuid REFERENCES approved_input_snapshots(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  decided_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((decision = 'approved') = (approved_input_snapshot_id IS NOT NULL))
);
CREATE INDEX plan_approval_decisions_ticket_created_idx
  ON plan_approval_decisions (ticket_id, created_at DESC);

CREATE FUNCTION reject_approved_input_snapshot_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'approved input snapshots are immutable';
END;
$$;
CREATE TRIGGER approved_input_snapshots_immutable
BEFORE UPDATE OR DELETE ON approved_input_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_approved_input_snapshot_mutation();

CREATE FUNCTION reject_plan_approval_decision_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'plan approval decisions are append-only';
END;
$$;
CREATE TRIGGER plan_approval_decisions_append_only
BEFORE UPDATE OR DELETE ON plan_approval_decisions
FOR EACH ROW EXECUTE FUNCTION reject_plan_approval_decision_mutation();

ALTER TABLE tickets ADD COLUMN approved_input_snapshot_id uuid
  REFERENCES approved_input_snapshots(id) ON DELETE RESTRICT;

-- Existing approval fields cannot prove the exact inputs consumed at approval.
-- Keep them for compatibility, but require reapproval through a snapshot.
UPDATE tickets SET
  approved_plan_version_id = NULL,
  approved_plan_hash = NULL,
  approved_ticket_version = NULL,
  approved_project_config_version = NULL,
  approved_model_config_json = NULL,
  approved_skill_snapshot_id = NULL,
  approved_prompt_versions_json = NULL,
  plan_approved_at = NULL
WHERE approved_plan_version_id IS NOT NULL;
