-- 049: ticket AI columns become inheritable. NULL = inherit project/system
-- settings (resolveAiConfiguration already skips nulls). The stale-plan
-- trigger is suspended so the one-time reset does not flag approved plans;
-- approval snapshots hold the resolved models, so approved work is unaffected.
ALTER TABLE tickets
  ALTER COLUMN default_model DROP NOT NULL,
  ALTER COLUMN default_model DROP DEFAULT,
  ALTER COLUMN default_reasoning_level DROP NOT NULL,
  ALTER COLUMN default_reasoning_level DROP DEFAULT;

ALTER TABLE tickets DISABLE TRIGGER tickets_stale_approved_plan;
UPDATE tickets SET
  default_model=NULL, default_reasoning_level=NULL,
  planning_model=NULL, planning_reasoning_level=NULL,
  execution_model=NULL, execution_reasoning_level=NULL,
  repair_model=NULL, repair_reasoning_level=NULL;
ALTER TABLE tickets ENABLE TRIGGER tickets_stale_approved_plan;
