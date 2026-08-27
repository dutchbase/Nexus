export { checkImageExists, type ImageExistenceResult } from "./registry.ts";

export type CreatePullRequestInput = {
  owner: string;
  repository: string;
  title: string;
  body: string;
  head: string;
  base: string;
};

export type ProviderPullRequest = {
  number: number;
  html_url: string;
  state: string;
  draft: boolean;
  merged?: boolean;
  title: string;
  head: { ref: string; sha?: string };
  base: { ref: string; sha?: string };
  user?: { login?: string };
  review_state?: string | null;
  check_state?: string | null;
  created_at: string;
  updated_at: string;
  merged_at?: string | null;
  closed_at?: string | null;
  merge_commit_sha?: string | null;
  body?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
  requested_reviewers?: Array<{ login?: string }>;
  requested_teams?: Array<{ slug?: string }>;
};

export type ProviderGitHubPolicyInputs = {
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

export type GitHubCapability = {
  status: "ok" | "unauthorized" | "unreachable" | "not_configured";
  canRead: boolean;
  canWrite: boolean;
  reason: string | null;
  checkedAt: string;
};

export type GitHubFetchMetadata = {
  complete: boolean;
  fetchedAt: string;
  cursor: string | null;
  errorCode?: string;
  retryAt?: string;
};

export type GitHubListResult<T> = GitHubFetchMetadata & { items: T[] } & T[];

export class GitHubProviderError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
    public retryAt?: string,
    public endpoint?: string,
  ) {
    super(message);
    this.name = "GitHubProviderError";
  }
}

function apiBaseUrl() {
  const value = process.env.GITHUB_API_BASE_URL;
  if (!value) throw new Error("GITHUB_API_BASE_URL is required");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid GitHub API base URL");
  return url.toString().replace(/\/$/, "");
}

function authToken() {
  const value = process.env.GITHUB_TOKEN;
  if (!value) throw new Error("GITHUB_TOKEN is required");
  return value;
}

function graphqlUrl() {
  const url = new URL(apiBaseUrl());
  url.pathname = url.pathname.endsWith("/api/v3") ? url.pathname.replace(/\/api\/v3$/, "/api/graphql") : "/graphql";
  return url.toString();
}

function retryAt(response: Response) {
  const seconds = response.headers.get("retry-after");
  if (seconds && Number.isFinite(Number(seconds))) return new Date(Date.now() + Number(seconds) * 1000).toISOString();
  const reset = response.headers.get("x-ratelimit-reset");
  return reset && Number.isFinite(Number(reset)) ? new Date(Number(reset) * 1000).toISOString() : new Date(Date.now() + 60_000).toISOString();
}

const FORBIDDEN_RETRY_DELAY_MS = 15 * 60 * 1000;

async function errorFor(response: Response) {
  const detail = response.status === 403 ? await response.clone().text().catch(() => "") : "";
  const limited = response.status === 429
    || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || !!response.headers.get("retry-after") || /rate limit/i.test(detail)));
  const forbidden = !limited && (response.status === 401 || response.status === 403);
  const code = limited ? "rate_limited" : response.status >= 500 || response.status === 408 ? "transient" : "http_error";
  const retry = limited ? retryAt(response) : forbidden ? new Date(Date.now() + FORBIDDEN_RETRY_DELAY_MS).toISOString() : undefined;
  return new GitHubProviderError(code, `GitHub provider request failed with status ${response.status}`, response.status, retry, response.url);
}

async function jsonFor<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    throw new GitHubProviderError("invalid_response", "GitHub provider response decoding failed", response.status);
  }
}

async function responseFor(url: string, init: RequestInit = {}, allowStatuses: number[] = []): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const retryDelays = method === "GET" ? [0, 250, 500] : [0];
  let lastError: unknown;
  for (const delay of retryDelays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(10_000),
        headers: {
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          authorization: `Bearer ${authToken()}`,
          "x-github-api-version": "2022-11-28",
          ...init.headers,
        },
      });
      if (response.ok || allowStatuses.includes(response.status)) return response;
      const error = await errorFor(response);
      if (error.code !== "transient") throw error;
      lastError = error;
    } catch (error) {
      if (error instanceof GitHubProviderError && error.code !== "transient") throw error;
      lastError = error instanceof GitHubProviderError
        ? error
        : new GitHubProviderError("transient", "GitHub provider request failed", undefined);
    }
  }
  throw lastError;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return jsonFor<T>(await responseFor(`${apiBaseUrl()}${path}`, init));
}

async function requestRaw(path: string, init?: RequestInit): Promise<string> {
  return (await responseFor(`${apiBaseUrl()}${path}`, init)).text();
}

function pullsPath(owner: string, repository: string) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls`;
}

export async function findOpenPullRequestForHead(owner: string, repository: string, head: string) {
  const path = `${pullsPath(owner, repository)}?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`;
  const pullRequests = await request<ProviderPullRequest[]>(path);
  return pullRequests[0] ?? null;
}

export async function getPullRequest(owner: string, repository: string, number: number) {
  return request<ProviderPullRequest>(`${pullsPath(owner, repository)}/${number}`);
}

export async function createPullRequest(input: CreatePullRequestInput) {
  return request<ProviderPullRequest>(pullsPath(input.owner, input.repository), {
    method: "POST",
    body: JSON.stringify({
      title: input.title, body: input.body, head: input.head, base: input.base, draft: false,
    }),
  });
}

async function graphqlRequest<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await responseFor(graphqlUrl(), {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  });
  const payload = await jsonFor<{ data: T; errors?: unknown }>(response);
  if (payload.errors) {
    const limited = /rate[_ ]?limit/i.test(JSON.stringify(payload.errors));
    throw new GitHubProviderError(limited ? "rate_limited" : "graphql_error", "GitHub GraphQL request failed", response.status, limited ? retryAt(response) : undefined);
  }
  return payload.data as T;
}

export async function markReadyForReview(owner: string, repository: string, number: number) {
  const pr = await request<{ node_id: string }>(`${pullsPath(owner, repository)}/${number}`);
  await graphqlRequest(
    `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }`,
    { id: pr.node_id },
  );
}

export type MergeResult = { sha: string; merged: boolean; message: string };

export async function mergePullRequest(
  owner: string,
  repository: string,
  number: number,
  mergeMethod: "merge" | "squash" | "rebase" = "squash",
  expectedHeadSha: string,
) {
  return request<MergeResult>(`${pullsPath(owner, repository)}/${number}/merge`, {
    method: "PUT",
    body: JSON.stringify({ merge_method: mergeMethod, sha: expectedHeadSha }),
  });
}

export async function updatePullRequestBase(owner: string, repository: string, number: number, base: string) {
  return request<ProviderPullRequest>(`${pullsPath(owner, repository)}/${number}`, {
    method: "PATCH",
    body: JSON.stringify({ base }),
  });
}

export async function createPullRequestComment(
  owner: string,
  repo: string,
  number: number,
  body: string,
): Promise<{ id: number; html_url: string }> {
  return request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export async function listPullRequestComments(owner: string, repo: string, number: number) {
  return listPages(
    `${apiBaseUrl()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments?per_page=100`,
    (page) => page as Array<{ id: number; html_url: string; body?: string | null }>,
    (comment) => comment.id,
  );
}

export async function getPullRequestDiff(owner: string, repo: string, number: number): Promise<string> {
  return requestRaw(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`, {
    headers: { accept: "application/vnd.github.v3.diff" },
  });
}

function nextLink(response: Response, currentUrl: string) {
  const next = response.headers.get("link")?.split(",").find((value) => /rel="?next"?/.test(value))?.match(/<([^>]+)>/)?.[1];
  if (!next) return null;
  const url = new URL(next, currentUrl);
  return url.origin === new URL(currentUrl).origin ? url.toString() : null;
}

async function listPages<T>(
  initialUrl: string,
  itemsFor: (payload: any) => T[],
  keyFor?: (item: T) => string | number,
): Promise<GitHubListResult<T>> {
  const items: T[] = [];
  const keys = new Set<string | number>();
  let cursor: string | null = initialUrl;
  const fetchedAt = new Date().toISOString();
  while (cursor) {
    try {
      const response = await responseFor(cursor);
      for (const item of itemsFor(await jsonFor(response))) {
        const key = keyFor?.(item);
        if (key !== undefined && keys.has(key)) continue;
        if (key !== undefined) keys.add(key);
        items.push(item);
      }
      cursor = nextLink(response, cursor);
    } catch (error) {
      const providerError = error instanceof GitHubProviderError ? error : new GitHubProviderError("transient", "GitHub provider request failed");
      return Object.assign([...items], { items, complete: false, fetchedAt, cursor, errorCode: providerError.code, ...(providerError.retryAt ? { retryAt: providerError.retryAt } : {}) });
    }
  }
  return Object.assign([...items], { items, complete: true, fetchedAt, cursor: null });
}

export async function listPullRequests(
  owner: string,
  repository: string,
  state: "open" | "closed" | "all" = "all",
): Promise<GitHubListResult<ProviderPullRequest>> {
  return listPages(`${apiBaseUrl()}${pullsPath(owner, repository)}?state=${state}&per_page=100`, (page) => page, (item: ProviderPullRequest) => item.number);
}

export type CommitCheckStatus = {
  sha: string;
  checks: Array<{ context: string; appId: number | null; state: "success" | "pending" | "failure"; updatedAt: string }>;
  overallState: "success" | "pending" | "failure" | "none";
  fetchedAt: string;
};

export async function getCommitCheckStatus(owner: string, repository: string, sha: string): Promise<CommitCheckStatus> {
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  const checkRunsResult = await listPages<any>(`${apiBaseUrl()}${repoPath}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`, (page) => page.check_runs ?? []);
  const statusesResult = await listPages<any>(`${apiBaseUrl()}${repoPath}/commits/${encodeURIComponent(sha)}/status?per_page=100`, (page) => page.statuses ?? []);
  for (const result of [checkRunsResult, statusesResult]) {
    if (!result.complete) throw new GitHubProviderError(result.errorCode ?? "transient", "GitHub check status fetch failed", undefined, result.retryAt, result.cursor ?? undefined);
  }
  const checks: CommitCheckStatus["checks"] = [
    ...checkRunsResult.items.map((check: any) => ({
      context: check.name,
      appId: check.app?.id ?? null,
      state: check.status !== "completed" ? "pending" as const : check.conclusion === "success" ? "success" as const : "failure" as const,
      updatedAt: check.completed_at ?? check.started_at ?? check.created_at,
    })),
    ...statusesResult.items.map((status: any) => ({
      context: status.context,
      appId: null,
      state: status.state === "success" ? "success" as const : status.state === "pending" ? "pending" as const : "failure" as const,
      updatedAt: status.updated_at ?? status.created_at,
    })),
  ];
  const overallState: CommitCheckStatus["overallState"] = checks.length === 0 ? "none"
    : checks.some((c) => c.state === "failure") ? "failure"
    : checks.some((c) => c.state === "pending") ? "pending"
    : "success";
  return { sha, checks, overallState, fetchedAt: new Date().toISOString() };
}

export async function getPullRequestPolicyInputs(owner: string, repository: string, number: number): Promise<ProviderGitHubPolicyInputs> {
  const pullRequest = await getPullRequest(owner, repository, number);
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  const headSha = pullRequest.head.sha;
  if (!headSha) throw new GitHubProviderError("invalid_response", "GitHub pull request head SHA is missing");

  const protectionResponse = await responseFor(`${apiBaseUrl()}${repoPath}/branches/${encodeURIComponent(pullRequest.base.ref)}/protection`, {}, [404, 403]);
  // Private repos without GitHub Pro/Team get a 403 "Upgrade to GitHub Pro" for this
  // endpoint regardless of token scope -- branch protection cannot exist there, so
  // this is equivalent to the 404 case. Any other 403 (e.g. real permission denial)
  // still surfaces as an error, same as before.
  const protectionPlanRestricted = protectionResponse.status === 403
    && /upgrade to github (pro|team)/i.test(await protectionResponse.clone().text().catch(() => ""));
  if (protectionResponse.status === 403 && !protectionPlanRestricted) throw await errorFor(protectionResponse);
  const protection = protectionResponse.status === 404 || protectionPlanRestricted ? null : await jsonFor<any>(protectionResponse);
  const requestedReviewers: ProviderGitHubPolicyInputs["requestedReviewers"] = [
    ...(pullRequest.requested_reviewers ?? []).flatMap((reviewer) => reviewer.login ? [{ type: "user" as const, name: reviewer.login }] : []),
    ...(pullRequest.requested_teams ?? []).flatMap((team) => team.slug ? [{ type: "team" as const, name: team.slug }] : []),
  ];
  if (protection === null) return {
    pullRequest,
    protected: false,
    requiredApprovals: 0,
    reviews: [],
    requestedReviewers,
    requiredChecks: [],
    checks: [],
    complete: true,
    fetchedAt: new Date().toISOString(),
  };
  const reviewsResult = await listPages<any>(`${apiBaseUrl()}${repoPath}/pulls/${number}/reviews?per_page=100`, (page) => page);
  if (!reviewsResult.complete) throw new GitHubProviderError(reviewsResult.errorCode ?? "transient", "GitHub policy input fetch failed", undefined, reviewsResult.retryAt, reviewsResult.cursor ?? undefined);
  const commitChecks = await getCommitCheckStatus(owner, repository, headSha);
  const reviewerPermissions = new Map(await Promise.all([...new Set(reviewsResult.items
    .filter((review: any) => ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state?.toUpperCase()) && review.user?.login && review.user?.type !== "Bot")
    .map((review: any) => review.user.login as string))]
    .map(async (reviewer) => {
      const permission = await request<{ permission: string }>(`${repoPath}/collaborators/${encodeURIComponent(reviewer)}/permission`);
      return [reviewer.toLowerCase(), ["admin", "write"].includes(permission.permission)] as const;
    })));
  const reviewRule = protection?.required_pull_request_reviews;
  const unsupported = [
    ...(reviewRule?.require_code_owner_reviews ? ["code_owner_reviews_unsupported"] : []),
    ...(reviewRule?.require_last_push_approval ? ["last_push_approval_unsupported"] : []),
  ];
  const requiredChecks = (protection?.required_status_checks?.checks
    ?? protection?.required_status_checks?.contexts?.map((context: string) => ({ context, app_id: null }))
    ?? []).map((check: any) => ({ context: check.context, appId: check.app_id ?? null }));
  return {
    pullRequest,
    protected: protection !== null,
    requiredApprovals: reviewRule?.required_approving_review_count ?? 0,
    reviews: reviewsResult.items.map((review: any) => ({
      id: review.id,
      reviewer: review.user?.login ?? "",
      state: review.state,
      commitSha: review.commit_id,
      submittedAt: review.submitted_at,
      qualifies: reviewerPermissions.get(review.user?.login?.toLowerCase()) ?? false,
    })).filter((review) => review.reviewer),
    requestedReviewers,
    requiredChecks,
    checks: commitChecks.checks,
    complete: unsupported.length === 0,
    ...(unsupported.length ? { incompleteReason: unsupported.join(",") } : {}),
    fetchedAt: new Date().toISOString(),
  };
}

export async function getBranchHeadCommit(owner: string, repository: string, branch: string):
  Promise<{ sha: string; committedAt: string; message: string }> {
  const commit = await request<any>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${encodeURIComponent(branch)}`);
  return { sha: commit.sha, committedAt: commit.commit?.committer?.date ?? commit.commit?.author?.date, message: commit.commit?.message ?? "" };
}

export async function getPullRequestsForCommit(owner: string, repository: string, sha: string):
  Promise<Array<{ number: number; merged: boolean; labels: string[] }>> {
  const items = await request<any[]>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${encodeURIComponent(sha)}/pulls`, {
    headers: { accept: "application/vnd.github.groot-preview+json" },
  });
  return items.map((pr) => ({ number: pr.number, merged: pr.merged_at != null, labels: (pr.labels ?? []).map((l: any) => l.name) }));
}

export async function updateBranchReference(owner: string, repository: string, branch: string, sha: string, force = false): Promise<{ sha: string }> {
  const response = await responseFor(
    `${apiBaseUrl()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/refs/heads/${encodeURIComponent(branch)}`,
    { method: "PATCH", body: JSON.stringify({ sha, force }) },
    [422],
  );
  if (response.status === 422) throw new GitHubProviderError("http_error", `branch ref update was rejected (force:${force})`, 422);
  const body = await jsonFor<{ object: { sha: string } }>(response);
  return { sha: body.object.sha };
}

export async function getPendingDeployments(owner: string, repository: string, sha: string):
  Promise<Array<{ environment: string; waiting: boolean }>> {
  const runs = await request<{ workflow_runs: any[] }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=5`);
  const newestRun = runs.workflow_runs?.[0];
  if (!newestRun) return [];
  const pending = await request<any[]>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/runs/${newestRun.id}/pending_deployments`);
  return pending.map((entry) => ({ environment: entry.environment?.name ?? "unknown", waiting: entry.current_user_can_approve !== undefined || entry.reviewers?.length > 0 }));
}

export type BranchMergeResult =
  | { outcome: "merged"; sha: string }
  | { outcome: "already_up_to_date" }
  | { outcome: "conflict" };

export async function mergeBranch(owner: string, repository: string, base: string, head: string): Promise<BranchMergeResult> {
  const response = await responseFor(`${apiBaseUrl()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/merges`, {
    method: "POST",
    body: JSON.stringify({ base, head }),
  }, [204, 409]);
  if (response.status === 201) { const b = await jsonFor<{ sha: string }>(response); return { outcome: "merged", sha: b.sha }; }
  if (response.status === 204) return { outcome: "already_up_to_date" };
  if (response.status === 409) return { outcome: "conflict" };
  throw await errorFor(response);
}

// Pure classifier: given a `GET /repos/{owner}/{repo}` response body (or null
// when the repository could not be read at all) and an optional
// `X-OAuth-Scopes` header value, derives what the configured token can
// actually do. Never inspects or calls a write endpoint itself.
export function capabilityFromRepo(
  body: { permissions?: { pull?: boolean; push?: boolean } } | null,
  scopesHeader: string | null,
): Omit<GitHubCapability, "checkedAt"> {
  if (!body) {
    return { status: "unauthorized", canRead: false, canWrite: false, reason: "GitHub repository is not accessible with the configured token" };
  }
  const canRead = body.permissions?.pull === true;
  const canWrite = body.permissions?.push === true;
  if (!canRead) {
    return {
      status: "unauthorized",
      canRead: false,
      canWrite: false,
      reason: scopesHeader ? `token scopes (${scopesHeader}) do not include repository read access` : "token does not have pull permission on this repository",
    };
  }
  return { status: "ok", canRead, canWrite, reason: null };
}

// Issues exactly one read-only `GET /repos/{owner}/{repo}` request and
// classifies the result. Never calls a write/mutating GitHub endpoint.
export async function probeGitHubCapability(owner: string, repository: string): Promise<GitHubCapability> {
  const checkedAt = new Date().toISOString();
  if (!process.env.GITHUB_API_BASE_URL || !process.env.GITHUB_TOKEN) {
    return { status: "not_configured", canRead: false, canWrite: false, reason: "GITHUB_API_BASE_URL or GITHUB_TOKEN is not configured", checkedAt };
  }
  try {
    const response = await responseFor(
      `${apiBaseUrl()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
      {},
      [401, 403, 404],
    );
    if (response.status === 401 || response.status === 403) {
      return { status: "unauthorized", canRead: false, canWrite: false, reason: `GitHub returned HTTP ${response.status}`, checkedAt };
    }
    if (response.status === 404) {
      return { status: "unauthorized", canRead: false, canWrite: false, reason: "repository not found or inaccessible with the configured token", checkedAt };
    }
    const body = await jsonFor<{ permissions?: { pull?: boolean; push?: boolean } }>(response);
    const scopesHeader = response.headers.get("x-oauth-scopes");
    return { ...capabilityFromRepo(body, scopesHeader), checkedAt };
  } catch (error) {
    return {
      status: "unreachable",
      canRead: false,
      canWrite: false,
      reason: error instanceof Error ? error.message : "GitHub capability probe failed",
      checkedAt,
    };
  }
}
