import type { ProviderPullRequest } from "../../github-provider/src/index.ts";

export type GitHubPolicyInputs = {
  pullRequest: ProviderPullRequest;
  protected: boolean;
  requiredApprovals: number;
  reviews: Array<{ id: number; reviewer: string; state: string; commitSha: string; submittedAt: string; qualifies: boolean }>;
  requestedReviewers: Array<{ type: "user" | "team"; name: string }>;
  requiredChecks: Array<{ context: string; appId: number | null }>;
  checks: Array<{ context: string; appId: number | null; state: "success" | "pending" | "failure"; updatedAt: string }>;
  complete: boolean;
  incompleteReason?: string;
  fetchedAt: string;
};

const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

export function evaluatePullRequestPolicy(inputs: GitHubPolicyInputs) {
  const headSha = inputs.pullRequest.head.sha ?? "";
  const latestReviews = new Map<string, GitHubPolicyInputs["reviews"][number]>();
  for (const review of inputs.reviews) {
    if (!review.qualifies || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state.toUpperCase())) continue;
    const prior = latestReviews.get(review.reviewer);
    if (!prior || review.submittedAt > prior.submittedAt || (review.submittedAt === prior.submittedAt && review.id > prior.id)) {
      latestReviews.set(review.reviewer, review);
    }
  }
  const reviews = [...latestReviews.values()].filter((review) => review.commitSha === headSha)
    .sort((left, right) => compare(left.reviewer, right.reviewer));
  const checks = [...inputs.checks].sort((left, right) =>
    compare(`${left.context}\0${left.appId ?? ""}\0${left.updatedAt}\0${left.state}`, `${right.context}\0${right.appId ?? ""}\0${right.updatedAt}\0${right.state}`));
  const requiredChecks = [...inputs.requiredChecks].sort((left, right) =>
    compare(`${left.context}\0${left.appId ?? ""}`, `${right.context}\0${right.appId ?? ""}`));
  const requestedReviewers = [...inputs.requestedReviewers].sort((left, right) =>
    compare(`${left.name}\0${left.type}`, `${right.name}\0${right.type}`));
  const material = {
    protected: inputs.protected,
    requiredApprovals: inputs.requiredApprovals,
    head: inputs.pullRequest.head,
    base: inputs.pullRequest.base,
    reviews,
    requestedReviewers,
    requiredChecks,
    checks,
    complete: inputs.complete,
    ...(inputs.incompleteReason ? { incompleteReason: inputs.incompleteReason } : {}),
  };

  if (!inputs.complete) {
    return { reviewState: "unknown" as const, checkState: "unknown" as const, refusalCodes: ["policy_incomplete"], material };
  }
  if (!inputs.protected) {
    return { reviewState: "not_required" as const, checkState: "not_required" as const, refusalCodes: [], material };
  }

  const latestChecks = new Map<string, GitHubPolicyInputs["checks"][number]>();
  for (const check of checks) {
    const key = `${check.context}\0${check.appId ?? ""}`;
    const prior = latestChecks.get(key);
    if (!prior || check.updatedAt > prior.updatedAt) latestChecks.set(key, check);
  }
  const requiredResults = requiredChecks.map((required) => {
    const states = [...latestChecks.values()]
      .filter((check) => check.context === required.context && (required.appId === null || check.appId === required.appId))
      .map((check) => check.state);
    return states.includes("failure") ? "failure" : states.length === 0 || states.includes("pending") ? "pending" : "success";
  });
  const checkState = requiredChecks.length === 0
    ? "not_required" as const
    : requiredResults.includes("failure")
      ? "failure" as const
      : requiredResults.includes("pending")
        ? "pending" as const
        : "success" as const;

  const states = reviews.map((review) => review.state.toUpperCase());
  const reviewState = inputs.requiredApprovals === 0
    ? "not_required" as const
    : states.includes("CHANGES_REQUESTED")
      ? "changes_requested" as const
      : states.filter((state) => state === "APPROVED").length >= inputs.requiredApprovals && requestedReviewers.length === 0
        ? "approved" as const
        : "pending" as const;
  const refusalCodes = [
    ...(reviewState === "changes_requested" ? ["changes_requested"] : reviewState === "pending" ? ["reviews_pending"] : []),
    ...(checkState === "failure" ? ["checks_failed"] : checkState === "pending" ? ["checks_pending"] : []),
  ];
  return { reviewState, checkState, refusalCodes, material };
}
