CREATE TABLE form_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  field_key text NOT NULL,
  field_type text NOT NULL,
  label text NOT NULL,
  description text,
  placeholder text,
  required boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  validation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  options_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (form_id, field_key)
);
CREATE INDEX form_fields_form_position_idx ON form_fields (form_id, position, created_at);

CREATE TABLE ticket_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  previous_status text,
  new_status text NOT NULL,
  reason text,
  actor_type text NOT NULL,
  actor_id uuid,
  related_job_id uuid REFERENCES jobs(id),
  related_run_id uuid REFERENCES agent_runs(id),
  related_plan_version_id uuid,
  related_pull_request_id uuid REFERENCES pull_requests(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_status_history_ticket_created_idx ON ticket_status_history (ticket_id, created_at DESC);

CREATE TABLE ticket_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_notes_ticket_created_idx ON ticket_notes (ticket_id, created_at DESC);

CREATE TABLE uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_path text NOT NULL UNIQUE,
  original_name text,
  media_type text NOT NULL,
  size_bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid REFERENCES tickets(id) ON DELETE CASCADE,
  upload_id uuid NOT NULL REFERENCES uploads(id) ON DELETE RESTRICT,
  field_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, upload_id)
);
CREATE INDEX attachments_ticket_idx ON attachments (ticket_id);

CREATE TABLE public_submission_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  ip_address text NOT NULL,
  accepted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX public_submission_attempts_limit_idx
  ON public_submission_attempts (form_id, ip_address, created_at DESC);

CREATE SEQUENCE ticket_number_sequence START WITH 1000;

CREATE INDEX tickets_status_idx ON tickets (status);
CREATE INDEX tickets_project_idx ON tickets (project_id);
CREATE INDEX tickets_form_idx ON tickets (form_id);
CREATE INDEX tickets_updated_idx ON tickets (updated_at DESC);
