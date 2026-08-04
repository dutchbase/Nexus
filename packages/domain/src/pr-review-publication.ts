import { parsePrReviewVerdict, PrReviewVerdictError } from "./pr-review.ts";

type Database = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

type Comment = { id: number; html_url: string; body?: string | null };

export class PrReviewPublicationError extends Error {
  constructor(message: string, readonly code: "incomplete_comment_search") {
    super(message);
  }
}

export class PrReviewDestinationError extends Error {
  readonly code = "review_destination_mismatch";
}

export function prReviewPublicationMarker(publicationId: string) {
  return `<!-- dcc-review-publication:${publicationId} -->`;
}

export function assertPrReviewDestination(review: { id: string; pull_request_id: string }, pullRequestId: string) {
  if (review.pull_request_id !== pullRequestId) {
    throw new PrReviewDestinationError(`PR review ${review.id} does not match payload pull request`);
  }
}

export async function resumePrReviewPublication(db: Database, input: {
  reviewId: string;
  invoke: () => Promise<{
    markdown: string;
    reviewedHeadSha: string;
    reviewedBaseBranch: string;
    reviewedBaseSha: string;
  }>;
  listComments: () => Promise<{ items: Comment[]; complete: boolean }>;
  createComment: (body: string) => Promise<Comment>;
  assertOwned?: () => Promise<void>;
}) {
  const assertOwned = input.assertOwned ?? (async () => {});
  let review = (await db.query("SELECT * FROM pr_ai_reviews WHERE id=$1", [input.reviewId])).rows[0];
  if (!review) throw new Error("pr_ai_reviews row not found");
  if (review.status !== "running") return review;

  if (!review.raw_output) {
    const result = await input.invoke();
    let verdict;
    try {
      verdict = parsePrReviewVerdict(result.markdown);
    } catch (error) {
      if (error instanceof PrReviewVerdictError) {
        await db.query(
          `UPDATE pr_ai_reviews
           SET status='error',raw_output=$2,reviewed_head_sha=$3,reviewed_base_branch=$4,reviewed_base_sha=$5,
               error_code=$6,error_message=$7,completed_at=now()
           WHERE id=$1 AND status='running'`,
          [input.reviewId, result.markdown, result.reviewedHeadSha, result.reviewedBaseBranch, result.reviewedBaseSha, error.code, error.message],
        );
      }
      throw error;
    }
    review = (await db.query(
      `UPDATE pr_ai_reviews
       SET raw_output=$2,parsed_verdict=$3,summary=$4,reviewed_head_sha=$5,reviewed_base_branch=$6,reviewed_base_sha=$7
       WHERE id=$1 AND status='running' AND raw_output IS NULL RETURNING *`,
      [input.reviewId, result.markdown, verdict.verdict, verdict.summary, result.reviewedHeadSha, result.reviewedBaseBranch, result.reviewedBaseSha],
    )).rows[0] ?? (await db.query("SELECT * FROM pr_ai_reviews WHERE id=$1", [input.reviewId])).rows[0];
  }

  const marker = prReviewPublicationMarker(review.publication_id);
  const body = `${review.raw_output.trimEnd()}\n\n${marker}`;
  try {
    review = (await db.query(
      `UPDATE pr_ai_reviews
       SET publication_attempt_count=publication_attempt_count+1,last_publication_error=NULL
       WHERE id=$1 AND status='running' RETURNING *`,
      [input.reviewId],
    )).rows[0] ?? review;
    await assertOwned();
    const comments = await input.listComments();
    if (!comments.complete) {
      throw new PrReviewPublicationError("GitHub comment search was incomplete; refusing duplicate publication", "incomplete_comment_search");
    }
    let comment = comments.items.find((item) => item.body === body);
    if (!comment) {
      await assertOwned();
      comment = await input.createComment(body);
    }
    await assertOwned();
    const published = (await db.query(
      `UPDATE pr_ai_reviews
       SET status=parsed_verdict,publication_status='published',github_comment_id=$2,github_comment_url=$3,
           last_publication_error=NULL,error_message=NULL,completed_at=now()
       WHERE id=$1 AND status='running' AND parsed_verdict IS NOT NULL RETURNING *`,
      [input.reviewId, comment.id, comment.html_url],
    )).rows[0];
    if (published) return published;
    review = (await db.query("SELECT * FROM pr_ai_reviews WHERE id=$1", [input.reviewId])).rows[0];
    if (review?.publication_status === "published") return review;
    throw new Error("PR review publication could not be finalized");
  } catch (error) {
    try {
      await assertOwned();
      await db.query(
        "UPDATE pr_ai_reviews SET last_publication_error=$2 WHERE id=$1 AND status='running'",
        [input.reviewId, error instanceof Error ? error.message : "PR review publication failed"],
      );
    } catch {}
    throw error;
  }
}
