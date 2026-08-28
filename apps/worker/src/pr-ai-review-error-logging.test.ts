import { describe, expect, it } from "vitest";
import { formatPrAiReviewFailureLog } from "./pr-ai-review-failure-log.ts";

describe("formatPrAiReviewFailureLog", () => {
  it("includes job id, pr_ai_review_id, pull_request_id, error code, and message", () => {
    const line = formatPrAiReviewFailureLog({
      jobId: "job-1",
      prAiReviewId: "review-1",
      pullRequestId: "pr-1",
      error: Object.assign(new Error("inconsistent types deduced for parameter $2"), { code: "42P08" }),
    });
    expect(line).toContain("job=job-1");
    expect(line).toContain("pr_ai_review_id=review-1");
    expect(line).toContain("pull_request_id=pr-1");
    expect(line).toContain("code=42P08");
    expect(line).toContain("inconsistent types deduced for parameter $2");
  });

  it("falls back to 'unknown' when the error has no code", () => {
    const line = formatPrAiReviewFailureLog({
      jobId: "job-2",
      prAiReviewId: "review-2",
      pullRequestId: "pr-2",
      error: new Error("GitHub API rate limited"),
    });
    expect(line).toContain("code=unknown");
    expect(line).toContain("GitHub API rate limited");
  });
});
