-- Migration 033 clears legacy approval pointers because they cannot prove the
-- immutable inputs. Return those tickets to the existing plan-review path.
UPDATE tickets
SET status='Plan Ready for Review',updated_at=now()
WHERE status='Plan Approved'
  AND approved_input_snapshot_id IS NULL
  AND approved_plan_version_id IS NULL
  AND plan_approved_at IS NULL;
