import type pg from "pg";
import { getPullRequest, markReadyForReview, mergePullRequest, updatePullRequestBase } from "../../github-provider/src/index.ts";
import { syncPullRequest } from "./pull-request-sync.ts";

export type PullRequestRow = {
  id: string;
  repository: string;
  number: number;
  base_branch: string;
  is_draft: boolean;
};

// Thrown only for failures during the GitHub update/merge calls, so callers can
// distinguish "the merge itself failed" (worth surfacing as e.g. a 502) from
// failures in the surrounding DB work, which should propagate like any other
// unexpected error. Mirrors the try/catch scope of the original inline handler.
export class PullRequestMergeError extends Error {}

export async function approveAndMergePullRequest(
  pool: pg.Pool,
  pullRequest: PullRequestRow,
  targetBranch: string | undefined,
  actor: { type: "worker" | "admin"; id: string },
  expectedHeadSha?: string,
  expectedBaseBranch?: string,
  expectedBaseSha?: string,
  assertOwned: () => Promise<void> = async () => {},
): Promise<void> {
  const [owner, repo] = pullRequest.repository.split("/");
  const providerCall = async <T>(action: () => Promise<T>) => {
    await assertOwned();
    let result: T;
    try {
      result = await action();
    } catch (error) {
      throw new PullRequestMergeError(error instanceof Error ? error.message : "merge failed");
    }
    await assertOwned();
    return result;
  };
  if (targetBranch && targetBranch !== pullRequest.base_branch) {
    await providerCall(() => updatePullRequestBase(owner, repo, pullRequest.number, targetBranch));
  }
  const remote = await providerCall(() => getPullRequest(owner, repo, pullRequest.number));
  if (remote.draft) await providerCall(() => markReadyForReview(owner, repo, pullRequest.number));
  if (expectedBaseBranch) {
    if (remote.base.ref !== expectedBaseBranch || (expectedBaseSha && remote.base.sha !== expectedBaseSha)) {
      throw new PullRequestMergeError("pull request base changed after AI review");
    }
  }
  await providerCall(() => mergePullRequest(owner, repo, pullRequest.number, "squash", expectedHeadSha));

  await pool.query(
    "UPDATE pull_requests SET internal_review_state='approved',updated_at=now() WHERE id=$1",
    [pullRequest.id],
  );
  await assertOwned();

  await syncPullRequest(pullRequest.id, actor.type, actor.id, assertOwned);
}
