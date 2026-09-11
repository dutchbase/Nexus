ALTER TABLE uploads
  ADD COLUMN owner_user_id uuid REFERENCES users(id),
  ADD COLUMN project_id uuid REFERENCES projects(id),
  ADD COLUMN claim_expires_at timestamptz;

CREATE INDEX uploads_claim_expiry_idx ON uploads(claim_expires_at)
  WHERE claim_expires_at IS NOT NULL;
ALTER TABLE uploads ADD CONSTRAINT upload_authenticated_scope CHECK
  ((owner_user_id IS NULL AND project_id IS NULL) OR
   (owner_user_id IS NOT NULL AND project_id IS NOT NULL AND form_id IS NULL));
CREATE INDEX uploads_owner_project_idx ON uploads(owner_user_id,project_id,created_at);

CREATE TABLE authenticated_upload_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX authenticated_upload_attempts_user_time_idx
  ON authenticated_upload_attempts(user_id,created_at);
