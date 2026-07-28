CREATE TABLE prompt_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('global', 'project')),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  prompt_type text NOT NULL,
  file_path text NOT NULL,
  active_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (scope = 'global' AND project_id IS NULL) OR
    (scope = 'project' AND project_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX prompt_files_global_type_idx
  ON prompt_files (prompt_type) WHERE scope = 'global';
CREATE UNIQUE INDEX prompt_files_project_type_idx
  ON prompt_files (project_id, prompt_type) WHERE scope = 'project';

CREATE TABLE prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_file_id uuid NOT NULL REFERENCES prompt_files(id) ON DELETE RESTRICT,
  version integer NOT NULL,
  content text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (prompt_file_id, version)
);

ALTER TABLE prompt_files
  ADD CONSTRAINT prompt_files_active_version_fk
  FOREIGN KEY (active_version_id) REFERENCES prompt_versions(id) ON DELETE RESTRICT;

DO $$
DECLARE
  prompt_type_value text;
  prompt_file_id uuid;
  prompt_version_id uuid;
  prompt_content text;
BEGIN
  FOREACH prompt_type_value IN ARRAY ARRAY[
    'base', 'planning', 'plan-revision', 'execution', 'execution-repair', 'validation', 'pull-request'
  ] LOOP
    prompt_content := CASE prompt_type_value
      WHEN 'base' THEN 'Inspect the current implementation first. Preserve the existing architecture. Do not access secrets or modify files outside the repository.'
      WHEN 'planning' THEN 'Produce a precise, read-only implementation plan. Implement nothing during planning and report uncertainty.'
      WHEN 'plan-revision' THEN 'Revise only the parts of the plan affected by review feedback while preserving accepted decisions.'
      WHEN 'execution' THEN 'Implement precisely what the approved plan specifies, and nothing more. Do not commit, push, merge, or open a pull request.'
      WHEN 'execution-repair' THEN 'Repair only the reported execution or validation failure and preserve unrelated working changes.'
      WHEN 'validation' THEN 'Run the configured validation commands and report every failure accurately.'
      ELSE 'Prepare pull-request metadata for administrator review. Do not create, approve, or merge a pull request.'
    END;
    INSERT INTO prompt_files (scope,prompt_type,file_path)
      VALUES ('global',prompt_type_value,'prompts/global/' || prompt_type_value || '.md')
      RETURNING id INTO prompt_file_id;
    INSERT INTO prompt_versions (prompt_file_id,version,content,content_hash)
      VALUES (prompt_file_id,1,prompt_content,encode(digest(prompt_content,'sha256'),'hex'))
      RETURNING id INTO prompt_version_id;
    UPDATE prompt_files SET active_version_id=prompt_version_id WHERE id=prompt_file_id;
  END LOOP;
END;
$$;

CREATE FUNCTION create_project_prompt_files() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prompt_type_value text;
  prompt_file_id uuid;
  prompt_version_id uuid;
  prompt_content text;
BEGIN
  FOREACH prompt_type_value IN ARRAY ARRAY['context','planning','execution','testing','pull-request'] LOOP
    prompt_content := CASE prompt_type_value
      WHEN 'context' THEN COALESCE(NEW.description, NEW.name)
      WHEN 'planning' THEN 'Inspect this project''s entry points, architecture, APIs, database conventions, risks, and migration policy.'
      WHEN 'execution' THEN 'Follow this project''s existing architecture, filesystem boundaries, API conventions, and design-system rules.'
      WHEN 'testing' THEN 'Use the project-configured testing and verification commands. Do not weaken or remove existing tests.'
      ELSE 'Summarize the implemented scope, validation results, risks, and reviewer notes.'
    END;
    INSERT INTO prompt_files (scope,project_id,prompt_type,file_path)
      VALUES ('project',NEW.id,prompt_type_value,'prompts/projects/' || NEW.slug || '/' || prompt_type_value || '.md')
      RETURNING id INTO prompt_file_id;
    INSERT INTO prompt_versions (prompt_file_id,version,content,content_hash)
      VALUES (prompt_file_id,1,prompt_content,encode(digest(prompt_content,'sha256'),'hex'))
      RETURNING id INTO prompt_version_id;
    UPDATE prompt_files SET active_version_id=prompt_version_id WHERE id=prompt_file_id;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER projects_create_prompt_files
AFTER INSERT ON projects
FOR EACH ROW EXECUTE FUNCTION create_project_prompt_files();

DO $$
DECLARE existing_project projects%ROWTYPE;
  prompt_type_value text;
  prompt_file_id uuid;
  prompt_version_id uuid;
  prompt_content text;
BEGIN
  FOR existing_project IN SELECT * FROM projects LOOP
    FOREACH prompt_type_value IN ARRAY ARRAY['context','planning','execution','testing','pull-request'] LOOP
      prompt_content := CASE prompt_type_value
        WHEN 'context' THEN COALESCE(existing_project.description, existing_project.name)
        WHEN 'planning' THEN 'Inspect this project''s entry points, architecture, APIs, database conventions, risks, and migration policy.'
        WHEN 'execution' THEN 'Follow this project''s existing architecture, filesystem boundaries, API conventions, and design-system rules.'
        WHEN 'testing' THEN 'Use the project-configured testing and verification commands. Do not weaken or remove existing tests.'
        ELSE 'Summarize the implemented scope, validation results, risks, and reviewer notes.'
      END;
      INSERT INTO prompt_files (scope,project_id,prompt_type,file_path)
        VALUES ('project',existing_project.id,prompt_type_value,'prompts/projects/' || existing_project.slug || '/' || prompt_type_value || '.md')
        RETURNING id INTO prompt_file_id;
      INSERT INTO prompt_versions (prompt_file_id,version,content,content_hash)
        VALUES (prompt_file_id,1,prompt_content,encode(digest(prompt_content,'sha256'),'hex'))
        RETURNING id INTO prompt_version_id;
      UPDATE prompt_files SET active_version_id=prompt_version_id WHERE id=prompt_file_id;
    END LOOP;
  END LOOP;
END;
$$;

CREATE TABLE prompt_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  phase text NOT NULL,
  content text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  model text NOT NULL,
  reasoning_level text NOT NULL,
  skill_snapshot_id uuid REFERENCES skill_snapshots(id) ON DELETE RESTRICT,
  metadata_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prompt_snapshots_ticket_created_idx
  ON prompt_snapshots (ticket_id, created_at DESC);

CREATE FUNCTION reject_prompt_artifact_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'prompt versions and snapshots are immutable';
END;
$$;

CREATE FUNCTION verify_prompt_content_hash() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content_hash <> encode(digest(NEW.content,'sha256'),'hex') THEN
    RAISE EXCEPTION 'prompt content hash does not match content';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER prompt_versions_verify_hash
BEFORE INSERT ON prompt_versions
FOR EACH ROW EXECUTE FUNCTION verify_prompt_content_hash();

CREATE TRIGGER prompt_snapshots_verify_hash
BEFORE INSERT ON prompt_snapshots
FOR EACH ROW EXECUTE FUNCTION verify_prompt_content_hash();

CREATE TRIGGER prompt_versions_immutable
BEFORE UPDATE ON prompt_versions
FOR EACH ROW EXECUTE FUNCTION reject_prompt_artifact_update();

CREATE TRIGGER prompt_snapshots_immutable
BEFORE UPDATE ON prompt_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_prompt_artifact_update();
