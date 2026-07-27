CREATE TABLE ticket_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES skills(id),
  source text NOT NULL DEFAULT 'manual',
  selected_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, skill_id)
);
CREATE INDEX ticket_skills_ticket_idx ON ticket_skills (ticket_id, created_at);

CREATE TABLE skill_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
  run_id uuid REFERENCES agent_runs(id) ON DELETE RESTRICT,
  skills_json jsonb NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX skill_snapshots_ticket_created_idx ON skill_snapshots (ticket_id, created_at DESC);

CREATE UNIQUE INDEX project_skills_project_skill_type_idx
  ON project_skills (project_id, skill_id, attachment_type);

ALTER TABLE tickets
  ALTER COLUMN ai_configuration_mode SET DEFAULT 'basic',
  ALTER COLUMN default_model SET DEFAULT 'sonnet',
  ALTER COLUMN default_reasoning_level SET DEFAULT 'high';

UPDATE tickets SET
  ai_configuration_mode = COALESCE(ai_configuration_mode, 'basic'),
  default_model = COALESCE(default_model, 'sonnet'),
  default_reasoning_level = COALESCE(default_reasoning_level, 'high');

ALTER TABLE tickets
  ALTER COLUMN ai_configuration_mode SET NOT NULL,
  ALTER COLUMN default_model SET NOT NULL,
  ALTER COLUMN default_reasoning_level SET NOT NULL;

ALTER TABLE tickets ADD CONSTRAINT tickets_ai_configuration_mode_check
  CHECK (ai_configuration_mode IN ('basic', 'advanced'));

-- Snapshot rows are append-only. Updates are structurally forbidden even if
-- a future application route accidentally attempts one.
CREATE FUNCTION reject_skill_snapshot_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'skill snapshots are immutable';
END;
$$;

CREATE TRIGGER skill_snapshots_immutable
BEFORE UPDATE ON skill_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_skill_snapshot_update();
