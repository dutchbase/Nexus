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

CREATE FUNCTION canonical_jsonb(value jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      RETURN '{' || COALESCE((
        SELECT string_agg(to_jsonb(key)::text || ':' || canonical_jsonb(child), ',' ORDER BY key COLLATE "C")
        FROM jsonb_each(value) AS item(key, child)
      ), '') || '}';
    WHEN 'array' THEN
      RETURN '[' || COALESCE((
        SELECT string_agg(canonical_jsonb(item), ',' ORDER BY ordinality)
        FROM jsonb_array_elements(value) WITH ORDINALITY AS elements(item, ordinality)
      ), '') || ']';
    ELSE RETURN value::text;
  END CASE;
END;
$$;

CREATE FUNCTION verify_approved_input_hash() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.input_hash <> encode(digest(canonical_jsonb(NEW.material_input_json), 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'approved input hash does not match canonical material input';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER approved_input_snapshots_verify_hash
BEFORE INSERT ON approved_input_snapshots
FOR EACH ROW EXECUTE FUNCTION verify_approved_input_hash();

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

-- Every project writer, including config imports, advances the same material
-- revision. Health and validation timestamps remain operational-only.
CREATE FUNCTION bump_project_material_config_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.name,OLD.description,OLD.enabled,OLD.repository_path,OLD.agent_start_path,
      OLD.github_owner,OLD.github_repository,OLD.default_branch,OLD.config_json)
     IS DISTINCT FROM
     (NEW.name,NEW.description,NEW.enabled,NEW.repository_path,NEW.agent_start_path,
      NEW.github_owner,NEW.github_repository,NEW.default_branch,NEW.config_json)
     AND NEW.config_version = OLD.config_version THEN
    NEW.config_version := OLD.config_version + 1;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER projects_bump_material_config_version
BEFORE UPDATE ON projects
FOR EACH ROW EXECUTE FUNCTION bump_project_material_config_version();

CREATE OR REPLACE FUNCTION stale_plans_for_skill_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND (
        COALESCE((NEW.configuration_json->>'mandatory')::boolean,false) OR
        NEW.configuration_json ? 'required_phases'
      )) OR (TG_OP = 'UPDATE' AND (
        OLD.enabled IS DISTINCT FROM NEW.enabled OR OLD.version IS DISTINCT FROM NEW.version OR
        OLD.content_hash IS DISTINCT FROM NEW.content_hash OR OLD.configuration_json IS DISTINCT FROM NEW.configuration_json
      )) THEN
    UPDATE plans SET potentially_stale=true,updated_at=now()
    WHERE ticket_id IN (
      SELECT DISTINCT t.id FROM tickets t
      LEFT JOIN ticket_skills ts ON ts.ticket_id=t.id
      LEFT JOIN project_skills ps ON ps.project_id=t.project_id
      WHERE t.approved_plan_version_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR ts.skill_id=NEW.id OR ps.skill_id=NEW.id OR
             COALESCE((NEW.configuration_json->>'mandatory')::boolean,false))
    );
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER skills_stale_approved_plans ON skills;
CREATE TRIGGER skills_stale_approved_plans
AFTER INSERT OR UPDATE ON skills FOR EACH ROW
EXECUTE FUNCTION stale_plans_for_skill_change();
