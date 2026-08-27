export type PolicyStatusCode = "satisfied" | "not_applicable" | "failed" | "unavailable";

export type PolicyStatusInput = {
  headSha: string | null;
  currentPolicySnapshotId: string | null;
  policyStale: boolean;
  policyComplete: boolean | null;
  reviewState: string | null;
  checkState: string | null;
  policyErrorCode: string | null;
  policyRetryAfter: string | Date | null;
  enforcementMode: "auto" | "required" | "optional";
};

export type PolicyStatus = {
  code: PolicyStatusCode;
  /** Short label safe to show next to "GitHub: " in a status badge, e.g. "No applicable policies". */
  label: string;
  /** True when this status should NOT block Approve & merge (all other Dev Control checks aside). */
  allowsMerge: boolean;
  /**
   * True only when nothing is known to be wrong and the /approve route resolves this
   * status itself by running a live GitHub check (see pull-request-on-demand-sync.ts)
   * before re-deriving it. A UI may keep Approve & merge clickable here even though
   * allowsMerge is false — the route still answers with the real reason if the live
   * check blocks the merge. Never true for a recorded API failure or stale evidence.
   */
  resolvableOnApprove: boolean;
};

function unavailable(label: string, resolvableOnApprove = false): PolicyStatus {
  return { code: "unavailable", label, allowsMerge: false, resolvableOnApprove };
}

export function derivePolicyStatus(input: PolicyStatusInput): PolicyStatus {
  if (!input.headSha) return unavailable("Unavailable: head SHA missing");

  if (!input.currentPolicySnapshotId) {
    if (input.enforcementMode === "required") {
      return unavailable("Unavailable: policy snapshot missing");
    }
    if (input.policyErrorCode) {
      const retry = input.policyRetryAfter ? `; retry after ${new Date(input.policyRetryAfter).toLocaleString("nl-NL")}` : "";
      return unavailable(`Unavailable: ${input.policyErrorCode}${retry}`);
    }
    // auto/optional, never synced, no recorded failure: absence alone never merges,
    // so allowsMerge stays false. But /approve resolves this state itself by running
    // the on-demand sync (pull-request-on-demand-sync.ts) and re-deriving, so it is
    // flagged resolvable rather than left as a dead end the UI blocks forever.
    return unavailable("Not verified yet; checked on approve", true);
  }

  if (input.policyStale) {
    const retry = input.policyRetryAfter ? `; retry after ${new Date(input.policyRetryAfter).toLocaleString("nl-NL")}` : "";
    return unavailable(`Stale${input.policyErrorCode ? `: ${input.policyErrorCode}` : ""}${retry}`);
  }
  if (input.policyComplete === false || input.policyComplete === null) {
    return unavailable(`Incomplete${input.policyErrorCode ? `: ${input.policyErrorCode}` : ""}`);
  }

  const reviewOk = input.reviewState === "approved" || input.reviewState === "not_required";
  const checkOk = input.checkState === "success" || input.checkState === "not_required";
  if (input.reviewState === "not_required" && input.checkState === "not_required") {
    return { code: "not_applicable", label: "No applicable policies", allowsMerge: true, resolvableOnApprove: false };
  }
  if (reviewOk && checkOk) {
    return { code: "satisfied", label: "Policies satisfied", allowsMerge: true, resolvableOnApprove: false };
  }
  const reasons: string[] = [];
  if (!reviewOk) {
    reasons.push(input.reviewState === "changes_requested" ? "changes requested" : `reviews ${input.reviewState ?? "unknown"}`);
  }
  if (!checkOk) {
    reasons.push(input.checkState === "failure" ? "checks failed" : `checks ${input.checkState ?? "unknown"}`);
  }
  return { code: "failed", label: `Required: ${reasons.join(", ")}`, allowsMerge: false, resolvableOnApprove: false };
}
