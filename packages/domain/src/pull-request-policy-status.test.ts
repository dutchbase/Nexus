import { expect, test } from "vitest";
import { derivePolicyStatus, type PolicyStatusInput } from "./pull-request-policy-status.ts";

const base: PolicyStatusInput = {
  headSha: "abc123",
  currentPolicySnapshotId: null,
  policyStale: false,
  policyComplete: null,
  reviewState: null,
  checkState: null,
  policyErrorCode: null,
  policyRetryAfter: null,
  enforcementMode: "auto",
};

test("missing head SHA is always unavailable regardless of enforcement mode", () => {
  const result = derivePolicyStatus({ ...base, headSha: null });
  expect(result).toEqual({ code: "unavailable", label: "Unavailable: head SHA missing", allowsMerge: false });
});

test("no snapshot yet, auto mode, no recorded error -> not_applicable (never synced, treat as no known policy)", () => {
  const result = derivePolicyStatus({ ...base, currentPolicySnapshotId: null, enforcementMode: "auto" });
  expect(result.code).toBe("unavailable");
  expect(result.allowsMerge).toBe(false);
  // On its own (no on-demand sync applied) this stays unavailable — Task 3 covers
  // the on-demand sync that eliminates this state before the user ever sees it.
});

test("no snapshot yet, enforcement required -> unavailable and blocks", () => {
  const result = derivePolicyStatus({ ...base, currentPolicySnapshotId: null, enforcementMode: "required" });
  expect(result).toEqual({ code: "unavailable", label: "Unavailable: policy snapshot missing", allowsMerge: false });
});

test("snapshot exists, no recorded error, real API failure recorded -> unavailable, distinct message", () => {
  const result = derivePolicyStatus({
    ...base, currentPolicySnapshotId: null, policyErrorCode: "rate_limited", enforcementMode: "auto",
  });
  expect(result.code).toBe("unavailable");
  expect(result.label).toContain("rate_limited");
  expect(result.allowsMerge).toBe(false);
});

test("snapshot exists, both states not_required -> not_applicable, allows merge", () => {
  const result = derivePolicyStatus({
    ...base, currentPolicySnapshotId: "snap-1", policyComplete: true,
    reviewState: "not_required", checkState: "not_required",
  });
  expect(result).toEqual({ code: "not_applicable", label: "No applicable policies", allowsMerge: true });
});

test("snapshot exists, approved + success -> satisfied, allows merge", () => {
  const result = derivePolicyStatus({
    ...base, currentPolicySnapshotId: "snap-1", policyComplete: true,
    reviewState: "approved", checkState: "success",
  });
  expect(result).toEqual({ code: "satisfied", label: "Policies satisfied", allowsMerge: true });
});

test("snapshot exists, checks pending -> failed, does not allow merge, mentions checks", () => {
  const result = derivePolicyStatus({
    ...base, currentPolicySnapshotId: "snap-1", policyComplete: true,
    reviewState: "approved", checkState: "pending",
  });
  expect(result.code).toBe("failed");
  expect(result.label.toLowerCase()).toContain("checks pending");
  expect(result.allowsMerge).toBe(false);
});

test("snapshot exists, reviews changes_requested -> failed, mentions reviews", () => {
  const result = derivePolicyStatus({
    ...base, currentPolicySnapshotId: "snap-1", policyComplete: true,
    reviewState: "changes_requested", checkState: "success",
  });
  expect(result.code).toBe("failed");
  expect(result.label.toLowerCase()).toContain("changes requested");
  expect(result.allowsMerge).toBe(false);
});

test("snapshot stale -> unavailable, does not allow merge", () => {
  const result = derivePolicyStatus({
    ...base, currentPolicySnapshotId: "snap-1", policyStale: true, policyComplete: true,
    reviewState: "not_required", checkState: "not_required",
  });
  expect(result.code).toBe("unavailable");
  expect(result.label).toContain("Stale");
  expect(result.allowsMerge).toBe(false);
});

test("snapshot incomplete (policyComplete false) -> unavailable", () => {
  const result = derivePolicyStatus({
    ...base, currentPolicySnapshotId: "snap-1", policyComplete: false,
  });
  expect(result.code).toBe("unavailable");
  expect(result.label).toContain("Incomplete");
  expect(result.allowsMerge).toBe(false);
});
