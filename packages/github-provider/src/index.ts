export type CreatePullRequestInput = {
  owner: string;
  repository: string;
  title: string;
  body: string;
  head: string;
  base: string;
  draft: boolean;
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${authToken()}`,
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`GitHub provider request failed with status ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return response.json() as Promise<T>;
}

async function requestRaw(path: string, init?: RequestInit): Promise<string> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${authToken()}`,
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`GitHub provider request failed with status ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return response.text();
}

function pullsPath(owner: string, repository: string) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls`;
}

export async function findOpenPullRequestForHead(owner: string, repository: string, head: string) {
  const path = `${pullsPath(owner, repository)}?state=open&head=${encodeURIComponent(head)}`;
  const pullRequests = await request<ProviderPullRequest[]>(path);
  return pullRequests[0] ?? null;
}

export async function getPullRequest(owner: string, repository: string, number: number) {
  return request<ProviderPullRequest>(`${pullsPath(owner, repository)}/${number}`);
}

export async function createDraftPullRequest(input: CreatePullRequestInput) {
  return request<ProviderPullRequest>(pullsPath(input.owner, input.repository), {
    method: "POST",
    body: JSON.stringify({
      title: input.title, body: input.body, head: input.head, base: input.base, draft: input.draft,
    }),
  });
}

async function graphqlRequest<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${authToken()}` },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors) {
    throw new Error(`GitHub GraphQL request failed: ${payload.errors ? JSON.stringify(payload.errors) : response.status}`);
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

export async function listPullRequests(owner: string, repository: string, state: "open" | "closed" | "all" = "all") {
  return request<ProviderPullRequest[]>(`${pullsPath(owner, repository)}?state=${state}&per_page=100`);
}

export type BranchMergeResult =
  | { outcome: "merged"; sha: string }
  | { outcome: "already_up_to_date" }
  | { outcome: "conflict" };

export async function mergeBranch(owner: string, repository: string, base: string, head: string): Promise<BranchMergeResult> {
  const response = await fetch(`${apiBaseUrl()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/merges`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${authToken()}` },
    body: JSON.stringify({ base, head }),
  });
  if (response.status === 201) { const b = await response.json() as { sha: string }; return { outcome: "merged", sha: b.sha }; }
  if (response.status === 204) return { outcome: "already_up_to_date" };
  if (response.status === 409) return { outcome: "conflict" };
  const detail = await response.text().catch(() => "");
  throw new Error(`GitHub branch merge failed with status ${response.status}${detail ? `: ${detail}` : ""}`);
}
