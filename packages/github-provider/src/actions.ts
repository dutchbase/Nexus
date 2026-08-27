import { request } from "./index.ts";

export type WorkflowRunSummary = {
  id: number;
  name: string | null;
  headBranch: string;
  headSha: string;
  event: string;
  status: string; // "queued" | "in_progress" | "completed" | ...
  conclusion: string | null; // "success" | "failure" | "cancelled" | null while not completed
  createdAt: string;
  htmlUrl: string;
};

export async function findWorkflowRun(
  owner: string,
  repository: string,
  filter: { sha: string; branch: string; event: string; createdAfter?: string },
): Promise<WorkflowRunSummary | null> {
  const query = new URLSearchParams({
    head_sha: filter.sha,
    branch: filter.branch,
    event: filter.event,
    per_page: "10",
  });
  const result = await request<{ workflow_runs: any[] }>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/runs?${query.toString()}`,
  );
  const runs = (result.workflow_runs ?? [])
    .filter((run) => !filter.createdAfter || run.created_at >= filter.createdAfter)
    .sort((left, right) => (left.created_at < right.created_at ? 1 : -1));
  const newest = runs[0];
  if (!newest) return null;
  return {
    id: newest.id,
    name: newest.name ?? null,
    headBranch: newest.head_branch,
    headSha: newest.head_sha,
    event: newest.event,
    status: newest.status,
    conclusion: newest.conclusion ?? null,
    createdAt: newest.created_at,
    htmlUrl: newest.html_url,
  };
}

export type WorkflowJobSummary = { name: string; status: string; conclusion: string | null; htmlUrl: string };

export async function getWorkflowRunJobs(owner: string, repository: string, runId: number): Promise<WorkflowJobSummary[]> {
  const result = await request<{ jobs: any[] }>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/runs/${runId}/jobs?per_page=100`,
  );
  return (result.jobs ?? []).map((job) => ({
    name: job.name,
    status: job.status,
    conclusion: job.conclusion ?? null,
    htmlUrl: job.html_url,
  }));
}

export type CommitComparison = { status: "identical" | "ahead" | "behind" | "diverged"; aheadBy: number; behindBy: number };

export async function compareCommits(owner: string, repository: string, base: string, head: string): Promise<CommitComparison> {
  const result = await request<{ status: string; ahead_by: number; behind_by: number }>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
  );
  return { status: result.status as CommitComparison["status"], aheadBy: result.ahead_by, behindBy: result.behind_by };
}
