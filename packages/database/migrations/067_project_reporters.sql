DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE role NOT IN ('admin', 'reporter')) THEN
    RAISE EXCEPTION 'cannot apply 067: users contain roles other than admin or reporter';
  END IF;
END $$;

ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','reporter'));
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'reporter';

CREATE TABLE project_memberships (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_id)
);
CREATE INDEX project_memberships_project_idx ON project_memberships(project_id,user_id);

ALTER TABLE tickets
  ADD COLUMN created_by_user_id uuid REFERENCES users(id),
  ADD COLUMN submission_revision integer NOT NULL DEFAULT 1,
  ADD COLUMN submission_updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN submitter_deleted_at timestamptz,
  ADD COLUMN submitter_deleted_by uuid REFERENCES users(id);
UPDATE tickets SET submission_updated_at=created_at;
ALTER TABLE tickets ADD CONSTRAINT submitter_deletion_pair CHECK
  ((submitter_deleted_at IS NULL) = (submitter_deleted_by IS NULL));
CREATE INDEX tickets_reporter_list_idx ON tickets(project_id,submission_updated_at DESC,id)
  WHERE submitter_deleted_at IS NULL;
