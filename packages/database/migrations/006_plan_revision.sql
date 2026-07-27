-- Phase 6: immutable plan revisions and exact, snapshot-bound approvals.
ALTER TABLE plans
  ALTER COLUMN planning_session_id DROP NOT NULL,
  ADD COLUMN potentially_stale boolean NOT NULL DEFAULT false;

ALTER TABLE plan_versions
  ALTER COLUMN prompt_snapshot_id DROP NOT NULL,
  ALTER COLUMN agent_run_id DROP NOT NULL;

ALTER TABLE tickets
  ADD COLUMN approved_plan_hash text,
  ADD COLUMN approved_ticket_version timestamptz,
  ADD COLUMN approved_project_config_version integer,
  ADD COLUMN approved_model_config_json jsonb,
  ADD COLUMN approved_skill_snapshot_id uuid REFERENCES skill_snapshots(id) ON DELETE RESTRICT,
  ADD COLUMN approved_prompt_versions_json jsonb,
  ADD COLUMN plan_approved_at timestamptz;

-- The gate must fail closed even if persistent state is corrupted. Keeping
-- this pointer unconstrained allows the gate to handle (and audit) a
-- dangling approval as a controlled 4xx instead of surfacing a server error.
ALTER TABLE tickets DROP CONSTRAINT tickets_approved_plan_version_fk;

CREATE TABLE plan_review_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  plan_version_id uuid NOT NULL REFERENCES plan_versions(id) ON DELETE RESTRICT,
  feedback text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plan_review_feedback_plan_created_idx
  ON plan_review_feedback (plan_id, created_at DESC);

CREATE TABLE execution_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
  plan_version_id uuid NOT NULL REFERENCES plan_versions(id) ON DELETE RESTRICT,
  agent_run_id uuid REFERENCES agent_runs(id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL,
  branch_name text,
  worktree_path text,
  base_commit text,
  result_commit text,
  validation_status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (ticket_id, attempt_number)
);

CREATE FUNCTION mark_ticket_plan_potentially_stale(ticket_uuid uuid) RETURNS void
LANGUAGE sql AS $$
  UPDATE plans SET potentially_stale=true,updated_at=now()
  WHERE ticket_id=ticket_uuid
    AND EXISTS (
      SELECT 1 FROM tickets
      WHERE id=ticket_uuid AND approved_plan_version_id IS NOT NULL
    );
$$;

CREATE FUNCTION stale_plan_on_ticket_configuration_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approved_plan_version_id IS NOT NULL AND (
    OLD.title IS DISTINCT FROM NEW.title OR
    OLD.description IS DISTINCT FROM NEW.description OR
    OLD.category IS DISTINCT FROM NEW.category OR
    OLD.priority IS DISTINCT FROM NEW.priority OR
    OLD.project_id IS DISTINCT FROM NEW.project_id OR
    OLD.environment IS DISTINCT FROM NEW.environment OR
    OLD.expected_behavior IS DISTINCT FROM NEW.expected_behavior OR
    OLD.actual_behavior IS DISTINCT FROM NEW.actual_behavior OR
    OLD.reproduction_steps IS DISTINCT FROM NEW.reproduction_steps OR
    OLD.custom_values_json IS DISTINCT FROM NEW.custom_values_json OR
    OLD.ai_configuration_mode IS DISTINCT FROM NEW.ai_configuration_mode OR
    OLD.default_model IS DISTINCT FROM NEW.default_model OR
    OLD.default_reasoning_level IS DISTINCT FROM NEW.default_reasoning_level OR
    OLD.planning_model IS DISTINCT FROM NEW.planning_model OR
    OLD.planning_reasoning_level IS DISTINCT FROM NEW.planning_reasoning_level OR
    OLD.execution_model IS DISTINCT FROM NEW.execution_model OR
    OLD.execution_reasoning_level IS DISTINCT FROM NEW.execution_reasoning_level OR
    OLD.repair_model IS DISTINCT FROM NEW.repair_model OR
    OLD.repair_reasoning_level IS DISTINCT FROM NEW.repair_reasoning_level
  ) THEN
    PERFORM mark_ticket_plan_potentially_stale(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tickets_stale_approved_plan
AFTER UPDATE ON tickets FOR EACH ROW
EXECUTE FUNCTION stale_plan_on_ticket_configuration_change();

CREATE FUNCTION stale_plans_for_project_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.config_version IS DISTINCT FROM NEW.config_version THEN
    UPDATE plans SET potentially_stale=true,updated_at=now()
    WHERE ticket_id IN (
      SELECT id FROM tickets
      WHERE project_id=NEW.id AND approved_plan_version_id IS NOT NULL
    );
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER projects_stale_approved_plans
AFTER UPDATE ON projects FOR EACH ROW
EXECUTE FUNCTION stale_plans_for_project_change();

CREATE FUNCTION stale_plan_for_ticket_skill_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM mark_ticket_plan_potentially_stale(COALESCE(NEW.ticket_id,OLD.ticket_id));
  RETURN COALESCE(NEW,OLD);
END;
$$;
CREATE TRIGGER ticket_skills_stale_approved_plan
AFTER INSERT OR UPDATE OR DELETE ON ticket_skills FOR EACH ROW
EXECUTE FUNCTION stale_plan_for_ticket_skill_change();

CREATE FUNCTION stale_plans_for_project_skill_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE plans SET potentially_stale=true,updated_at=now()
  WHERE ticket_id IN (
    SELECT id FROM tickets
    WHERE project_id=COALESCE(NEW.project_id,OLD.project_id)
      AND approved_plan_version_id IS NOT NULL
  );
  RETURN COALESCE(NEW,OLD);
END;
$$;
CREATE TRIGGER project_skills_stale_approved_plans
AFTER INSERT OR UPDATE OR DELETE ON project_skills FOR EACH ROW
EXECUTE FUNCTION stale_plans_for_project_skill_change();

CREATE FUNCTION stale_plans_for_skill_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.enabled IS DISTINCT FROM NEW.enabled OR
     OLD.version IS DISTINCT FROM NEW.version OR
     OLD.content_hash IS DISTINCT FROM NEW.content_hash OR
     OLD.configuration_json IS DISTINCT FROM NEW.configuration_json THEN
    UPDATE plans SET potentially_stale=true,updated_at=now()
    WHERE ticket_id IN (
      SELECT DISTINCT t.id FROM tickets t
      LEFT JOIN ticket_skills ts ON ts.ticket_id=t.id
      LEFT JOIN project_skills ps ON ps.project_id=t.project_id
      WHERE t.approved_plan_version_id IS NOT NULL
        AND (ts.skill_id=NEW.id OR ps.skill_id=NEW.id OR
             COALESCE((NEW.configuration_json->>'mandatory')::boolean,false))
    );
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER skills_stale_approved_plans
AFTER UPDATE ON skills FOR EACH ROW
EXECUTE FUNCTION stale_plans_for_skill_change();

CREATE FUNCTION stale_plans_for_prompt_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.active_version_id IS DISTINCT FROM NEW.active_version_id THEN
    UPDATE plans SET potentially_stale=true,updated_at=now()
    WHERE ticket_id IN (
      SELECT t.id FROM tickets t
      WHERE t.approved_plan_version_id IS NOT NULL
        AND (NEW.scope='global' OR t.project_id=NEW.project_id)
    );
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER prompt_files_stale_approved_plans
AFTER UPDATE ON prompt_files FOR EACH ROW
EXECUTE FUNCTION stale_plans_for_prompt_change();
