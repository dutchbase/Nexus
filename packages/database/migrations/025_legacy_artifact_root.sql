ALTER TABLE artifacts ADD COLUMN storage_root text NOT NULL DEFAULT 'primary'
  CHECK (storage_root IN ('primary','legacy'));

-- Logs registered by the pre-023 upgrade are from the pre-DCC_DATA_DIR data
-- root. Keep that provenance so an independent upload root cannot hide them.
UPDATE artifacts
SET storage_root='legacy'
WHERE artifact_type='execution_log' AND execution_attempt_id IS NULL;
