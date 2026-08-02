ALTER TABLE tickets ADD CONSTRAINT tickets_status_lifecycle_check CHECK (status IN ($s$Submitted$s$, $s$Triage$s$, $s$Rejected$s$, $s$Approved for Planning$s$, $s$Planning Queued$s$, $s$Planning$s$, $s$Planning Failed$s$, $s$Plan Ready for Review$s$, $s$Plan Approved$s$, $s$Plan Revision Requested$s$, $s$Plan Revision Queued$s$, $s$Execution Queued$s$, $s$Executing$s$, $s$Validating$s$, $s$Validation Failed$s$, $s$Execution Failed$s$, $s$PR Ready for Review$s$, $s$PR Approved$s$, $s$PR Changes Requested$s$, $s$PR Creation Failed$s$, $s$Merged$s$, $s$Completed$s$, $s$Closed Without Merge$s$));
ALTER TABLE jobs ADD CONSTRAINT jobs_status_lifecycle_check CHECK (status IN ($s$queued$s$, $s$running$s$, $s$completed$s$, $s$failed$s$));
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_lifecycle_check CHECK (status IS NULL OR status IN ($s$queued$s$, $s$running$s$, $s$cancellation_requested$s$, $s$cancelled$s$, $s$completed$s$, $s$failed$s$));
ALTER TABLE execution_attempts ADD CONSTRAINT execution_attempts_status_lifecycle_check CHECK (validation_status IS NULL OR validation_status IN ($s$queued$s$, $s$pending$s$, $s$executing$s$, $s$validated$s$, $s$completed$s$, $s$failed$s$, $s$pr_creation_failed$s$));
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_status_lifecycle_check CHECK (status IS NULL OR status IN ($s$queued$s$, $s$sending$s$, $s$sent$s$, $s$failed$s$));

CREATE FUNCTION reject_append_only_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING MESSAGE = $msg$append-only rows cannot be updated or deleted$msg$;
END;
$$;

CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER ticket_status_history_append_only BEFORE UPDATE OR DELETE ON ticket_status_history FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER prompt_snapshots_append_only BEFORE UPDATE OR DELETE ON prompt_snapshots FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER prompt_versions_append_only BEFORE UPDATE OR DELETE ON prompt_versions FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER plan_versions_append_only BEFORE UPDATE OR DELETE ON plan_versions FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER skill_snapshots_append_only BEFORE UPDATE OR DELETE ON skill_snapshots FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER agent_run_events_append_only BEFORE UPDATE OR DELETE ON agent_run_events FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
