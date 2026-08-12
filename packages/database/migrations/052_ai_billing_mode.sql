-- 052: track billing mode per AI invocation. Claude CLI runs are billed
-- through the Anthropic subscription; DeepSeek (and, from Task B4 onward,
-- some Claude jobs routed through the pay-per-token Anthropic API) are
-- metered per-token. NULL = pre-existing invocation whose billing mode was
-- never recorded (mirrors the nullable provider/accounting columns added in
-- migration 050).
ALTER TABLE agent_runs
  ADD COLUMN billing_mode text CHECK (billing_mode IS NULL OR billing_mode IN ('subscription','api'));

-- Backfill: DeepSeek was always metered; Claude CLI was always subscription.
UPDATE agent_runs SET billing_mode = CASE WHEN provider = 'deepseek' THEN 'api' ELSE 'subscription' END
WHERE provider IS NOT NULL;
