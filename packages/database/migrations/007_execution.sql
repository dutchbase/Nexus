-- Phase 7: streamed execution events and cancellation coordination.
CREATE TABLE agent_run_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  sequence integer NOT NULL,
  event_type text NOT NULL,
  event_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_run_id, sequence)
);
CREATE INDEX agent_run_events_run_sequence_idx
  ON agent_run_events (agent_run_id, sequence);
