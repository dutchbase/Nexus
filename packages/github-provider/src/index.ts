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
  return reset && Number.isFinite(Number(reset)) ? new Date(Number(reset) * 1000).toISOString() : undefined;
}

function errorFor(response: Response) {
  const limited = response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
  const code = limited ? "rate_limited" : response.status >= 500 || response.status === 408 ? "transient" : "http_error";
  return new GitHubProviderError(code, `GitHub provider request failed with status ${response.status}`, response.status, limited ? retryAt(response) : undefined);
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
      const error = errorFor(response);
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return (await responseFor(`${apiBaseUrl()}${path}`, init)).json() as Promise<T>;
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
  const payload = await response.json() as { data: T; errors?: unknown };
  if (payload.errors) throw new GitHubProviderError("graphql_error", "GitHub GraphQL request failed");
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
  expectedHeadSha?: string,
) {
  return request<MergeResult>(`${pullsPath(owner, repository)}/${number}/merge`, {
    method: "PUT",
    body: JSON.stringify({ merge_method: mergeMethod, ...(expectedHeadSha ? { sha: expectedHeadSha } : {}) }),
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

export async function listPullRequests(
  owner: string,
  repository: string,
  state: "open" | "closed" | "all" = "all",
): Promise<GitHubListResult<ProviderPullRequest>> {
  const items: ProviderPullRequest[] = [];
  const numbers = new Set<number>();
  let cursor: string | null = `${apiBaseUrl()}${pullsPath(owner, repository)}?state=${state}&per_page=100`;
  const fetchedAt = new Date().toISOString();
  while (cursor) {
    try {
      const response = await responseFor(cursor);
      const page = await response.json() as ProviderPullRequest[];
      for (const item of page) if (!numbers.has(item.number)) {
        numbers.add(item.number);
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

export type BranchMergeResult =
  | { outcome: "merged"; sha: string }
  | { outcome: "already_up_to_date" }
  | { outcome: "conflict" };

export async function mergeBranch(owner: string, repository: string, base: string, head: string): Promise<BranchMergeResult> {
  const response = await responseFor(`${apiBaseUrl()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/merges`, {
    method: "POST",
    body: JSON.stringify({ base, head }),
  }, [204, 409]);
  if (response.status === 201) { const b = await response.json() as { sha: string }; return { outcome: "merged", sha: b.sha }; }
  if (response.status === 204) return { outcome: "already_up_to_date" };
  if (response.status === 409) return { outcome: "conflict" };
  throw errorFor(response);
}
