CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
  planning_session_id uuid NOT NULL,
  current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticket_id)
);

CREATE TABLE plan_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  version integer NOT NULL,
  content_markdown text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  prompt_snapshot_id uuid NOT NULL REFERENCES prompt_snapshots(id) ON DELETE RESTRICT,
  agent_run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, version)
);

ALTER TABLE plans ADD CONSTRAINT plans_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES plan_versions(id) ON DELETE RESTRICT;
ALTER TABLE tickets ADD CONSTRAINT tickets_approved_plan_version_fk
  FOREIGN KEY (approved_plan_version_id) REFERENCES plan_versions(id) ON DELETE RESTRICT;
ALTER TABLE ticket_status_history ADD CONSTRAINT ticket_status_history_plan_version_fk
  FOREIGN KEY (related_plan_version_id) REFERENCES plan_versions(id) ON DELETE RESTRICT;
ALTER TABLE agent_runs ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

CREATE FUNCTION reject_plan_version_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'plan versions are immutable';
END;
$$;

CREATE FUNCTION verify_plan_content_hash() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content_hash <> encode(digest(NEW.content_markdown,'sha256'),'hex') THEN
    RAISE EXCEPTION 'plan content hash does not match content';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER plan_versions_verify_hash BEFORE INSERT ON plan_versions
FOR EACH ROW EXECUTE FUNCTION verify_plan_content_hash();
CREATE TRIGGER plan_versions_immutable BEFORE UPDATE ON plan_versions
FOR EACH ROW EXECUTE FUNCTION reject_plan_version_update();
