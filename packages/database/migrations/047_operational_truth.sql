CREATE TABLE workers (
  id text PRIMARY KEY,
  version text,
  capabilities text[] NOT NULL DEFAULT '{}',
  started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE github_capability (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  status text NOT NULL,
  can_read boolean NOT NULL DEFAULT false,
  can_write boolean NOT NULL DEFAULT false,
  reason text,
  checked_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE agent_runs
  ADD COLUMN heartbeat_at timestamptz,
  ADD COLUMN phase text;
