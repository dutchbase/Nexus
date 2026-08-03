ALTER TABLE jobs
  ADD COLUMN rerun_of uuid REFERENCES jobs(id) ON DELETE RESTRICT,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN recovery_reason text;

ALTER TABLE notification_deliveries
  ADD COLUMN claimed_by text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN recovery_reason text;

CREATE TABLE execution_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_attempt_id uuid NOT NULL UNIQUE REFERENCES execution_attempts(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'publishing', 'published', 'failed')),
  last_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  pull_request_id uuid REFERENCES pull_requests(id) ON DELETE SET NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
