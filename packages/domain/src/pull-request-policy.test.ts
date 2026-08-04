import { expect, test } from "vitest";
import { evaluatePullRequestPolicy, type GitHubPolicyInputs } from "./pull-request-policy.ts";

const base = {
  pullRequest: {
    number: 42,
    html_url: "https://github.com/acme/widgets/pull/42",
    state: "open",
    draft: false,
    title: "Policy",
    head: { ref: "feature", sha: "head-sha" },
    base: { ref: "main", sha: "base-sha" },
    created_at: "2026-08-03T00:00:00Z",
    updated_at: "2026-08-04T00:00:00Z",
  },
  protected: true,
  requiredApprovals: 1,
  reviews: [],
  requestedReviewers: [],
  requiredChecks: [],
  checks: [],
  complete: true,
  fetchedAt: "2026-08-04T12:00:00Z",
} satisfies GitHubPolicyInputs;

test("uses each reviewer's latest current-head review", () => {
  const result = evaluatePullRequestPolicy({
    ...base,
    reviews: [
      { id: 1, reviewer: "alice", state: "APPROVED", commitSha: "head-sha", submittedAt: "2026-08-04T10:00:00Z" },
      { id: 2, reviewer: "alice", state: "CHANGES_REQUESTED", commitSha: "head-sha", submittedAt: "2026-08-04T11:00:00Z" },
      { id: 3, reviewer: "bob", state: "APPROVED", commitSha: "old-sha", submittedAt: "2026-08-04T12:00:00Z" },
    ],
  });

  expect(result.reviewState).toBe("changes_requested");
  expect(result.refusalCodes).toContain("changes_requested");
  expect(result.material.reviews).toEqual([
    { reviewer: "alice", state: "CHANGES_REQUESTED", commitSha: "head-sha", submittedAt: "2026-08-04T11:00:00Z", id: 2 },
  ]);
});

test("dismisses stale-SHA approvals and waits for requested reviewers", () => {
  const result = evaluatePullRequestPolicy({
    ...base,
    reviews: [{ id: 1, reviewer: "alice", state: "APPROVED", commitSha: "old-sha", submittedAt: "2026-08-04T10:00:00Z" }],
    requestedReviewers: [{ type: "user", name: "bob" }],
  });

  expect(result.reviewState).toBe("pending");
  expect(result.refusalCodes).toContain("reviews_pending");
});

test("requires every protected check and reports failures before pending checks", () => {
  const requiredChecks = [{ context: "build", appId: 7 }, { context: "lint", appId: null }];

  expect(evaluatePullRequestPolicy({ ...base, requiredChecks, checks: [] }).checkState).toBe("pending");
  expect(evaluatePullRequestPolicy({
    ...base,
    requiredChecks,
    checks: [
      { context: "build", appId: 7, state: "failure", updatedAt: "2026-08-04T11:00:00Z" },
      { context: "lint", appId: 9, state: "success", updatedAt: "2026-08-04T11:00:00Z" },
    ],
  })).toMatchObject({ checkState: "failure", refusalCodes: expect.arrayContaining(["checks_failed"]) });
});

test("does not invent requirements for an unprotected branch", () => {
  expect(evaluatePullRequestPolicy({ ...base, protected: false })).toMatchObject({
    reviewState: "not_required",
    checkState: "not_required",
    refusalCodes: [],
  });
});

test("refuses an unsupported protected policy as unknown", () => {
  expect(evaluatePullRequestPolicy({
    ...base,
    complete: false,
    incompleteReason: "code_owner_reviews_unsupported",
  })).toMatchObject({
    reviewState: "unknown",
    checkState: "unknown",
    refusalCodes: ["policy_incomplete"],
  });
});

test("canonicalizes policy material independently of provider ordering", () => {
  const checks = [
    { context: "build", appId: 8, state: "pending" as const, updatedAt: "2026-08-04T11:00:00Z" },
    { context: "build", appId: 7, state: "success" as const, updatedAt: "2026-08-04T11:00:00Z" },
  ];
  const requestedReviewers = [{ type: "team" as const, name: "platform" }, { type: "user" as const, name: "platform" }];

  const forward = evaluatePullRequestPolicy({ ...base, checks, requestedReviewers }).material;
  const reversed = evaluatePullRequestPolicy({ ...base, checks: [...checks].reverse(), requestedReviewers: [...requestedReviewers].reverse() }).material;

  expect(reversed).toEqual(forward);
});
