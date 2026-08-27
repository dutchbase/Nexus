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
};

function unavailable(label: string): PolicyStatus {
  return { code: "unavailable", label, allowsMerge: false };
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
    // auto/optional, never synced, no recorded failure: still unavailable on its
    // own — callers with the on-demand sync helper (see pull-request-on-demand-sync.ts)
    // should run that BEFORE calling derivePolicyStatus so this branch is rarely hit
    // by end users. It intentionally does not "pass" from absence alone.
    return unavailable("Unavailable: policy snapshot missing");
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
    return { code: "not_applicable", label: "No applicable policies", allowsMerge: true };
  }
  if (reviewOk && checkOk) {
    return { code: "satisfied", label: "Policies satisfied", allowsMerge: true };
  }
  const reasons: string[] = [];
  if (!reviewOk) {
    reasons.push(input.reviewState === "changes_requested" ? "changes requested" : `reviews ${input.reviewState ?? "unknown"}`);
  }
  if (!checkOk) {
    reasons.push(input.checkState === "failure" ? "checks failed" : `checks ${input.checkState ?? "unknown"}`);
  }
  return { code: "failed", label: `Required: ${reasons.join(", ")}`, allowsMerge: false };
}
