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
  head: { ref: string };
  base: { ref: string };
  user?: { login?: string };
  review_state?: string | null;
  check_state?: string | null;
  created_at: string;
  updated_at: string;
  merged_at?: string | null;
  closed_at?: string | null;
  merge_commit_sha?: string | null;
};

function apiBaseUrl() {
  const value = process.env.GITHUB_API_BASE_URL;
  if (!value) throw new Error("GITHUB_API_BASE_URL is required");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid GitHub API base URL");
  return url.toString().replace(/\/$/, "");
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) throw new Error(`GitHub provider request failed with status ${response.status}`);
  return response.json() as Promise<T>;
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
