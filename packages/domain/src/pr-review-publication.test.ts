import { expect, test, vi } from "vitest";
import * as domain from "./index.ts";

const markdown = "Review complete.\n\n```json\n{\"verdict\":\"approved\",\"summary\":\"Safe to merge.\"}\n```";

function database(options: { finalUpdateFailsOnce?: boolean } = {}) {
  const row: any = {
    id: "review-1", status: "running", publication_id: "publication-1",
    raw_output: null, parsed_verdict: null, summary: null,
    reviewed_head_sha: null, reviewed_base_branch: null, reviewed_base_sha: null,
    publication_status: "pending", publication_attempt_count: 0,
    github_comment_id: null, github_comment_url: null,
  };
  let finalUpdateFails = options.finalUpdateFailsOnce ?? false;
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith("SELECT")) return { rows: [{ ...row }], rowCount: 1 };
    if (sql.includes("raw_output=$2")) {
      Object.assign(row, {
        raw_output: values[1], parsed_verdict: values[2], summary: values[3],
        reviewed_head_sha: values[4], reviewed_base_branch: values[5], reviewed_base_sha: values[6],
      });
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.includes("publication_attempt_count=publication_attempt_count+1")) {
      row.publication_attempt_count += 1;
      row.last_publication_error = null;
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.includes("github_comment_id=$2")) {
      if (finalUpdateFails) {
        finalUpdateFails = false;
        throw new Error("database unavailable after GitHub accepted the comment");
      }
      Object.assign(row, {
        github_comment_id: values[1], github_comment_url: values[2], publication_status: "published",
        status: row.parsed_verdict, completed_at: "now",
      });
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.includes("last_publication_error=$2")) {
      row.last_publication_error = values[1];
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  return { query, row };
}

const input = (overrides: Record<string, unknown> = {}) => ({
  reviewId: "review-1",
  invoke: vi.fn(async () => ({
    markdown,
    reviewedHeadSha: "head-1",
    reviewedBaseBranch: "main",
    reviewedBaseSha: "base-1",
  })),
  listComments: vi.fn(async () => ({ items: [], complete: true })),
  createComment: vi.fn(async () => ({ id: 7, html_url: "https://github.test/comment/7" })),
  ...overrides,
});

test("persists immutable output, verdict, and reviewed refs before posting", async () => {
  const db = database();
  const args = input({
    createComment: vi.fn(async () => {
      expect(db.row).toMatchObject({
        raw_output: markdown, parsed_verdict: "approved", summary: "Safe to merge.",
        reviewed_head_sha: "head-1", reviewed_base_branch: "main", reviewed_base_sha: "base-1",
      });
      return { id: 7, html_url: "https://github.test/comment/7" };
    }),
  });

  await (domain as any).resumePrReviewPublication(db, args);

  expect(db.row).toMatchObject({ status: "approved", publication_status: "published", github_comment_id: 7 });
});

test("fails closed when comment lookup is incomplete", async () => {
  const db = database();
  const args = input({ listComments: vi.fn(async () => ({ items: [], complete: false })) });

  await expect((domain as any).resumePrReviewPublication(db, args))
    .rejects.toMatchObject({ code: "incomplete_comment_search" });

  expect(args.createComment).not.toHaveBeenCalled();
  expect(db.row).toMatchObject({ status: "running", publication_status: "pending", publication_attempt_count: 1 });
});

test("does not trust an unrelated comment that only copies the publication marker", async () => {
  const db = database();
  const createComment = vi.fn(async () => ({ id: 8, html_url: "https://github.test/comment/8" }));
  const args = input({
    listComments: vi.fn(async () => ({
      complete: true,
      items: [{
        id: 7,
        html_url: "https://github.test/comment/7",
        body: "Spoofed content.\n\n<!-- dcc-review-publication:publication-1 -->",
      }],
    })),
    createComment,
  });

  await (domain as any).resumePrReviewPublication(db, args);

  expect(createComment).toHaveBeenCalledWith(`${markdown}\n\n<!-- dcc-review-publication:publication-1 -->`);
  expect(db.row.github_comment_id).toBe(8);
});

test("rejects a durable job whose review belongs to another pull request", () => {
  expect(() => (domain as any).assertPrReviewDestination(
    { id: "review-1", pull_request_id: "pr-1" },
    "pr-2",
  )).toThrow("does not match payload pull request");
});

test("retries one review identity without invoking Claude or posting twice", async () => {
  const db = database({ finalUpdateFailsOnce: true });
  let posted: { id: number; html_url: string; body: string } | null = null;
  const invoke = vi.fn(async () => ({
    markdown, reviewedHeadSha: "head-1", reviewedBaseBranch: "main", reviewedBaseSha: "base-1",
  }));
  const listComments = vi.fn()
    .mockResolvedValueOnce({ items: [], complete: true })
    .mockResolvedValueOnce({ items: [], complete: false })
    .mockImplementationOnce(async () => ({ items: [posted], complete: true }));
  const createComment = vi.fn(async (body: string) => {
    posted = { id: 7, html_url: "https://github.test/comment/7", body };
    return posted;
  });
  const args = input({ invoke, listComments, createComment });

  await expect((domain as any).resumePrReviewPublication(db, args)).rejects.toThrow("database unavailable");
  await expect((domain as any).resumePrReviewPublication(db, args)).rejects.toMatchObject({ code: "incomplete_comment_search" });
  await expect((domain as any).resumePrReviewPublication(db, args)).resolves.toMatchObject({
    id: "review-1", publication_id: "publication-1", status: "approved", github_comment_id: 7,
  });

  expect(invoke).toHaveBeenCalledTimes(1);
  expect(createComment).toHaveBeenCalledTimes(1);
  expect(posted!.body).toContain("<!-- dcc-review-publication:publication-1 -->");
  expect(db.row.publication_attempt_count).toBe(3);
});

test("leaves terminal review history untouched", async () => {
  const db = database();
  Object.assign(db.row, { status: "error", error_code: "invalid_verdict_json", completed_at: "now" });
  const args = input();

  await expect((domain as any).resumePrReviewPublication(db, args)).resolves.toMatchObject({ status: "error" });

  expect(args.invoke).not.toHaveBeenCalled();
  expect(args.listComments).not.toHaveBeenCalled();
  expect(db.query).toHaveBeenCalledTimes(1);
});
