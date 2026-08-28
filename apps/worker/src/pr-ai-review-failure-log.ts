export function formatPrAiReviewFailureLog(input: { jobId: string; prAiReviewId: string; pullRequestId: string; error: unknown }): string {
  const err = input.error as { code?: unknown; message?: unknown };
  const code = typeof err?.code === "string" ? err.code : "unknown";
  const message = err instanceof Error ? err.message : String(err?.message ?? err);
  return `pr_ai_review failed: job=${input.jobId} pr_ai_review_id=${input.prAiReviewId} pull_request_id=${input.pullRequestId} code=${code} message=${message}`;
}
