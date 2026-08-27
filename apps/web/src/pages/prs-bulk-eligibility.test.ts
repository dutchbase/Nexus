import { expect, test } from "vitest";
import { classifyBulkMergeEligibility } from "./prs.ts";

const base = {
  state: "open", head_sha: "abc123", current_policy_snapshot_id: "snap-1", policy_stale: false,
  policy_complete: true, review_state: "approved", check_state: "success", is_draft: false, merge_conflicts: false,
};

test("eligible when everything is clean", () => {
  expect(classifyBulkMergeEligibility(base, true)).toEqual({ eligible: true });
});
test("draft PRs are blocked regardless of policy state", () => {
  expect(classifyBulkMergeEligibility({ ...base, is_draft: true }, true)).toMatchObject({ eligible: false, reason: expect.stringMatching(/draft/i) });
});
test("PRs with merge conflicts are blocked", () => {
  expect(classifyBulkMergeEligibility({ ...base, merge_conflicts: true }, true)).toMatchObject({ eligible: false, reason: expect.stringMatching(/conflict/i) });
});
test("closed/merged PRs are blocked", () => {
  expect(classifyBulkMergeEligibility({ ...base, state: "merged" }, true)).toMatchObject({ eligible: false, reason: expect.stringMatching(/merged/i) });
});
test("changes requested blocks when enforcement is on", () => {
  expect(classifyBulkMergeEligibility({ ...base, review_state: "changes_requested" }, true)).toMatchObject({ eligible: false });
});
test("policy checks are skipped when enforcement is off", () => {
  expect(classifyBulkMergeEligibility({ ...base, current_policy_snapshot_id: null }, false)).toEqual({ eligible: true });
});
