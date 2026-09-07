import { GitHubProviderError, request } from "./index.ts";

const RUN_PAGE_SIZE = 20;
const RUN_PAGE_LIMIT = 3;
const JOB_PAGE_SIZE = 100;
const JOB_PAGE_LIMIT = 3;
const DISCOVERY_TIMEOUT_MS = 10_000;

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

function workflowRunSummary(run: any): WorkflowRunSummary {
  return {
    id: run.id,
    name: run.name ?? null,
    headBranch: run.head_branch,
    headSha: run.head_sha,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion ?? null,
    createdAt: run.created_at,
    htmlUrl: run.html_url,
  };
}

export async function findWorkflowRun(
  owner: string,
  repository: string,
  filter: { sha: string; branch: string; event: string; createdAfter?: string | Date; requiredJobs?: string[]; signal?: AbortSignal },
): Promise<WorkflowRunSummary | null> {
  const signal = filter.signal
    ? AbortSignal.any([filter.signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)])
    : AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  const query = new URLSearchParams({
    head_sha: filter.sha,
    branch: filter.branch,
    event: filter.event,
    per_page: String(RUN_PAGE_SIZE),
  });
  const createdAfter = filter.createdAfter ? new Date(filter.createdAfter).getTime() : null;
  const requiredJobs = filter.requiredJobs ?? [];
  const candidates: any[] = [];
  for (let page = 1; page <= RUN_PAGE_LIMIT; page++) {
    query.set("page", String(page));
    const result = await request<{ workflow_runs: any[] }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/runs?${query.toString()}`,
      { signal },
    );
    const pageRuns = result.workflow_runs ?? [];
    const runs = pageRuns
      .filter((run) => createdAfter === null || new Date(run.created_at).getTime() >= createdAfter)
      .sort(newestRunFirst);
    candidates.push(...runs);
    if (requiredJobs.length === 0 && runs[0]) return workflowRunSummary(runs[0]);
    for (const run of runs) {
      const jobs = await getWorkflowRunJobs(owner, repository, run.id, { signal, requiredJobs });
      if (requiredJobs.every((required) => jobs.some((job) => job.name === required))) {
        const identity = workflowIdentity(run);
        if (!identity) continue;
        const newest = candidates.filter((candidate) => workflowIdentity(candidate) === identity).sort(newestRunFirst)[0];
        return newest ? workflowRunSummary(newest) : null;
      }
    }
    if (pageRuns.length < RUN_PAGE_SIZE || (createdAfter !== null && runs.length === 0)) return null;
  }
  throw new GitHubProviderError("incomplete_response", "GitHub workflow discovery exceeded its bounded page limit");
}

function workflowIdentity(run: any) {
  if (typeof run.workflow_id === "number" || typeof run.workflow_id === "string" && run.workflow_id) return `id:${run.workflow_id}`;
  return typeof run.path === "string" && run.path.trim() ? `path:${run.path}` : null;
}

function newestRunFirst(left: any, right: any) {
  const created = String(right.created_at).localeCompare(String(left.created_at));
  return created || Number(right.run_attempt ?? 1) - Number(left.run_attempt ?? 1) || Number(right.id) - Number(left.id);
}

export type WorkflowJobSummary = { name: string; status: string; conclusion: string | null; htmlUrl: string };

export async function getWorkflowRunJobs(
  owner: string,
  repository: string,
  runId: number,
  options: { signal?: AbortSignal; requiredJobs?: string[] } = {},
): Promise<WorkflowJobSummary[]> {
  const signal = options.signal ?? AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  const jobs: WorkflowJobSummary[] = [];
  for (let page = 1; page <= JOB_PAGE_LIMIT; page++) {
    const result = await request<{ jobs: any[] }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/runs/${runId}/jobs?per_page=${JOB_PAGE_SIZE}&page=${page}`,
      { signal },
    );
    const pageJobs = (result.jobs ?? []).map((job) => ({
      name: job.name,
      status: job.status,
      conclusion: job.conclusion ?? null,
      htmlUrl: job.html_url,
    }));
    jobs.push(...pageJobs);
    if (options.requiredJobs?.every((required) => jobs.some((job) => job.name === required))) return jobs;
    if (pageJobs.length < JOB_PAGE_SIZE) return jobs;
  }
  throw new GitHubProviderError("incomplete_response", "GitHub workflow jobs exceeded the bounded page limit");
}

export type CommitComparison = { status: "identical" | "ahead" | "behind" | "diverged"; aheadBy: number; behindBy: number };

export async function compareCommits(owner: string, repository: string, base: string, head: string): Promise<CommitComparison> {
  const result = await request<{ status: string; ahead_by: number; behind_by: number }>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
  );
  return { status: result.status as CommitComparison["status"], aheadBy: result.ahead_by, behindBy: result.behind_by };
}
