import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";

process.env.DATABASE_URL = process.env.DCC_TEST_DATABASE_URL ?? "postgres://unused:unused@127.0.0.1:1/unused";
const { migrate } = await import("../../database/src/migrate.ts");
const { recordAiUsage, createAiInvocation } = await import("./index.ts");
const { resumePrReviewPublication, prReviewPublicationMarker } = await import("./pr-review-publication.ts");

const testDatabaseUrl = process.env.DCC_TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
let migrationDirectory = "";
let client: pg.Client;

async function resetDatabase() {
  const reset = new pg.Client({ connectionString: testDatabaseUrl });
  await reset.connect();
  try { await reset.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"); } finally { await reset.end(); }
}

async function seedProjectAndPr() {
  const projectId = (await client.query(
    "INSERT INTO projects (slug,name,repository_path,github_owner,github_repository) VALUES ('pub-test','Pub Test','/tmp','dutchbase','dev-control') RETURNING id",
  )).rows[0].id;
  const pullRequestId = (await client.query(
    "INSERT INTO pull_requests (project_id,number,title,head_branch,base_branch,repository) VALUES ($1,1,'t','feature','master','dutchbase/dev-control') RETURNING id",
    [projectId],
  )).rows[0].id;
  return { projectId, pullRequestId };
}

async function seedReview(pullRequestId: string, overrides: Partial<{ status: string; raw_output: string | null; parsed_verdict: string | null; github_comment_id: number | null; publication_status: string }> = {}) {
  const row = (await client.query(
    `INSERT INTO pr_ai_reviews (pull_request_id,mode,status,model,reasoning_level,raw_output,parsed_verdict,github_comment_id,publication_status)
     VALUES ($1,'review_only',$2,'sonnet','medium',$3,$4,$5,$6) RETURNING *`,
    [pullRequestId, overrides.status ?? "running", overrides.raw_output ?? null, overrides.parsed_verdict ?? null, overrides.github_comment_id ?? null, overrides.publication_status ?? "pending"],
  )).rows[0];
  return row;
}

integration("AI PR review publication (Sonnet / review_only / medium)", () => {
  beforeAll(async () => {
    migrationDirectory = await mkdtemp(join(tmpdir(), "dcc-pr-review-pub-"));
    await cp(new URL("../../database/migrations/", import.meta.url), migrationDirectory, { recursive: true });
  });
  beforeEach(async () => {
    await resetDatabase();
    await migrate({ connectionString: testDatabaseUrl!, directory: migrationDirectory });
    client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
  }, 20_000);
  afterEach(async () => { await client?.end(); }, 20_000);
  afterAll(async () => { if (migrationDirectory) await rm(migrationDirectory, { recursive: true, force: true }); });

  it("completes end to end for sonnet/review_only/medium without a parameter type error", async () => {
    const { projectId, pullRequestId } = await seedProjectAndPr();
    const review = await seedReview(pullRequestId);

    const runId = "00000000-0000-4000-8000-0000000000a1";
    await createAiInvocation({ id: runId, projectId, pullRequestId, runType: "pr_ai_review", model: "sonnet", reasoningLevel: "medium" }, client);
    await expect(recordAiUsage({ runId, inputTokens: 12000, outputTokens: 3400, reasoningTokens: 900, cacheReadTokens: 500, cacheWriteTokens: 200, rawUsage: { provider: "anthropic" } }, client)).resolves.toMatchObject({ ai_usage_status: "captured" });

    const created = { id: 555, html_url: "https://github.com/dutchbase/dev-control/pull/1#issuecomment-555" };
    const listComments = vi.fn().mockResolvedValue({ items: [], complete: true });
    const createComment = vi.fn().mockResolvedValue(created);
    const published = await resumePrReviewPublication(client, {
      reviewId: review.id,
      invoke: async () => ({ markdown: "Looks good overall.\n\n```json\n{\"verdict\":\"approved\",\"summary\":\"Looks good.\"}\n```\n", reviewedHeadSha: "a".repeat(40), reviewedBaseBranch: "master", reviewedBaseSha: "b".repeat(40) }),
      listComments,
      createComment,
    });

    expect(published.status).toBe("approved");
    expect(published.publication_status).toBe("published");
    expect(published.github_comment_id).toBe("555"); // node-postgres returns bigint columns as strings, not numbers, by default
    expect(createComment).toHaveBeenCalledTimes(1);
  });

  it("does not create a duplicate GitHub comment when retried after a transient failure", async () => {
    const { pullRequestId } = await seedProjectAndPr();
    // parsed_verdict must be set (not null) here: the real resumePrReviewPublication always writes
    // raw_output and parsed_verdict together in one UPDATE (pr-review-publication.ts:63-68) — a row
    // with raw_output set but parsed_verdict null is not a reachable state, and the function's final
    // UPDATE requires "parsed_verdict IS NOT NULL" to finalize publication (pr-review-publication.ts:95),
    // so leaving it null here would make this test throw "PR review publication could not be finalized"
    // instead of exercising the retry path it's meant to test.
    const review = await seedReview(pullRequestId, { raw_output: "## Verdict\napproved\n\n## Summary\nfine", parsed_verdict: "approved" });
    const marker = prReviewPublicationMarker(review.publication_id);
    const body = `## Verdict\napproved\n\n## Summary\nfine\n\n${marker}`;
    const existingComment = { id: 777, html_url: "https://github.com/x/y/pull/1#issuecomment-777", body };

    const createComment = vi.fn().mockResolvedValue(existingComment);
    const republished = await resumePrReviewPublication(client, {
      reviewId: review.id,
      invoke: async () => { throw new Error("invoke should not be called: raw_output already set"); },
      listComments: async () => ({ items: [existingComment], complete: true }),
      createComment,
    });

    expect(createComment).not.toHaveBeenCalled();
    expect(republished.github_comment_id).toBe("777"); // node-postgres returns bigint columns as strings, not numbers, by default
    expect(republished.publication_status).toBe("published");
  });

  it("retrying does not touch or get blocked by a historical failed review on the same PR", async () => {
    const { pullRequestId } = await seedProjectAndPr();
    const failedReview = await seedReview(pullRequestId, { status: "error" });
    await client.query("UPDATE pr_ai_reviews SET error_code=$2, error_message=$3 WHERE id=$1", [failedReview.id, "42P08", "inconsistent types deduced for parameter $2"]);

    const freshReview = await seedReview(pullRequestId);
    const createComment = vi.fn().mockResolvedValue({ id: 900, html_url: "https://example.test/900" });
    const published = await resumePrReviewPublication(client, {
      reviewId: freshReview.id,
      invoke: async () => ({ markdown: "Needs more work before merge.\n\n```json\n{\"verdict\":\"rejected\",\"summary\":\"needs work\"}\n```\n", reviewedHeadSha: "c".repeat(40), reviewedBaseBranch: "master", reviewedBaseSha: "d".repeat(40) }),
      listComments: async () => ({ items: [], complete: true }),
      createComment,
    });

    expect(published.status).toBe("rejected");
    expect(createComment).toHaveBeenCalledTimes(1);
    const stillFailed = (await client.query("SELECT status, error_code FROM pr_ai_reviews WHERE id=$1", [failedReview.id])).rows[0];
    expect(stillFailed).toEqual({ status: "error", error_code: "42P08" });
  });

  it("resuming a non-running review is a no-op and leaves github_comment_id null rather than erroring", async () => {
    const { pullRequestId } = await seedProjectAndPr();
    const errored = await seedReview(pullRequestId, { status: "error", github_comment_id: null });
    const createComment = vi.fn();
    const result = await resumePrReviewPublication(client, {
      reviewId: errored.id,
      invoke: async () => { throw new Error("should not invoke"); },
      listComments: async () => ({ items: [], complete: true }),
      createComment,
    });
    expect(result.status).toBe("error");
    expect(result.github_comment_id).toBeNull();
    expect(createComment).not.toHaveBeenCalled();
  });
});
