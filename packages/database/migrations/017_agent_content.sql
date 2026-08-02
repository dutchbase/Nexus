CREATE TABLE agent_content (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  sync jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
