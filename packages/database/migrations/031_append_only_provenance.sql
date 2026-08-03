CREATE OR REPLACE FUNCTION reject_artifact_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'artifacts are append-only'; END; $$;
DROP TRIGGER IF EXISTS artifact_delete_protection ON artifacts;
CREATE TRIGGER artifact_delete_protection BEFORE DELETE ON artifacts FOR EACH ROW EXECUTE FUNCTION reject_artifact_delete();
CREATE OR REPLACE FUNCTION reject_backup_recovery_verification_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'backup recovery verifications are append-only'; END; $$;
DROP TRIGGER IF EXISTS backup_recovery_verification_mutation ON backup_recovery_verifications;
CREATE TRIGGER backup_recovery_verification_mutation BEFORE UPDATE OR DELETE ON backup_recovery_verifications FOR EACH ROW EXECUTE FUNCTION reject_backup_recovery_verification_mutation();
