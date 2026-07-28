ALTER TABLE notification_deliveries
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX notification_deliveries_due_idx
  ON notification_deliveries (next_attempt_at, created_at)
  WHERE status IN ('queued', 'failed');
