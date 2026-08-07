CREATE TABLE system_ai_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  default_model text NOT NULL DEFAULT 'sonnet',
  default_reasoning_level text NOT NULL DEFAULT 'high',
  planning_model text,
  planning_reasoning_level text,
  execution_model text,
  execution_reasoning_level text,
  repair_model text,
  repair_reasoning_level text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO system_ai_settings (id) VALUES (1);
