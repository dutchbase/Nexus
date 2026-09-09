-- DCC-1032: the ticket list gets a Delete quick action for tickets that never
-- entered the planning pipeline. ticket_status_history cascades from tickets
-- (002_forms_and_tickets.sql), but 020_data_lifecycle.sql's append-only trigger
-- rejected that cascade, so DELETE FROM tickets aborted with P0001 for every
-- ticket ever created — each one has a creation-time history row.
-- History rows stay append-only for every other caller; the sole exception is
-- the cascade, which runs after its parent ticket row is already gone.
CREATE OR REPLACE FUNCTION reject_ticket_status_history_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM tickets WHERE id = OLD.ticket_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING MESSAGE = $msg$append-only rows cannot be updated or deleted$msg$;
END;
$$;

DROP TRIGGER IF EXISTS ticket_status_history_append_only ON ticket_status_history;
CREATE TRIGGER ticket_status_history_append_only
  BEFORE UPDATE OR DELETE ON ticket_status_history
  FOR EACH ROW EXECUTE FUNCTION reject_ticket_status_history_change();
