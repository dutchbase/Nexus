ALTER TABLE notification_providers
  ADD COLUMN enabled_events jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 5
    CONSTRAINT notification_providers_max_attempts_check CHECK (max_attempts BETWEEN 1 AND 10);

-- Backfill: existing providers keep receiving every currently emitted event.
UPDATE notification_providers SET enabled_events =
  '["ticket.created","planning.started","planning.failed","plan.ready_for_review","execution.started","execution.completed","pr.ready_for_review"]'::jsonb;

-- Terminal retry-exhaustion state (extends 020 check).
ALTER TABLE notification_deliveries DROP CONSTRAINT IF EXISTS notification_deliveries_status_lifecycle_check;
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_status_lifecycle_check
  CHECK (status IS NULL OR status IN ('queued','sending','sent','failed','exhausted'));

-- G08-F04: strip non-HTTPS endpoint configuration (style precedent: 034).
UPDATE notification_providers
SET configuration_encrypted_json = configuration_encrypted_json - 'base_url'
WHERE configuration_encrypted_json ? 'base_url'
  AND configuration_encrypted_json->>'base_url' !~* '^https://';
UPDATE notification_providers
SET configuration_encrypted_json = configuration_encrypted_json - 'endpoint'
WHERE configuration_encrypted_json ? 'endpoint'
  AND configuration_encrypted_json->>'endpoint' ~* '^[a-z][a-z0-9+.-]*:'
  AND configuration_encrypted_json->>'endpoint' !~* '^https://';
