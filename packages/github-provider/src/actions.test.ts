import { expect, test, vi, beforeEach, afterEach } from "vitest";
import { findWorkflowRun, getWorkflowRunJobs, compareCommits } from "./actions.ts";

const originalApiBaseUrl = process.env.GITHUB_API_BASE_URL;
const originalToken = process.env.GITHUB_TOKEN;

beforeEach(() => {
  // request()/apiBaseUrl() require GITHUB_API_BASE_URL to be set, in addition
  // to GITHUB_TOKEN — the base URL value itself is irrelevant since fetch is
  // mocked below, but apiBaseUrl() throws before ever reaching fetch if unset.
  process.env.GITHUB_API_BASE_URL = "https://api.github.example";
  process.env.GITHUB_TOKEN = "test-token";
  vi.restoreAllMocks();
});

afterEach(() => {
  if (originalApiBaseUrl === undefined) delete process.env.GITHUB_API_BASE_URL;
  else process.env.GITHUB_API_BASE_URL = originalApiBaseUrl;
  if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalToken;
});

function mockFetchOnce(status: number, body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

test("findWorkflowRun filters by head_sha, branch, and event, and picks the newest match", async () => {
  const fetchSpy = mockFetchOnce(200, {
    workflow_runs: [
      { id: 2, name: "CI", head_branch: "master", head_sha: "a".repeat(40), event: "push", status: "completed", conclusion: "success", created_at: "2026-01-02T00:00:00Z", html_url: "https://x/2" },
      { id: 1, name: "CI", head_branch: "master", head_sha: "a".repeat(40), event: "push", status: "completed", conclusion: "success", created_at: "2026-01-01T00:00:00Z", html_url: "https://x/1" },
    ],
  });
  const run = await findWorkflowRun("dutchbase", "va-jobs-platform", { sha: "a".repeat(40), branch: "master", event: "push" });
  expect(run?.id).toBe(2);
  const calledUrl = fetchSpy.mock.calls[0][0] as string;
  expect(calledUrl).toContain("head_sha=" + "a".repeat(40));
  expect(calledUrl).toContain("branch=master");
  expect(calledUrl).toContain("event=push");
});

test("findWorkflowRun returns null when no run matches", async () => {
  mockFetchOnce(200, { workflow_runs: [] });
  const run = await findWorkflowRun("dutchbase", "va-jobs-platform", { sha: "a".repeat(40), branch: "production", event: "push" });
  expect(run).toBeNull();
});

test("findWorkflowRun ignores a run older than createdAfter", async () => {
  mockFetchOnce(200, {
    workflow_runs: [
      { id: 1, name: "CI", head_branch: "master", head_sha: "a".repeat(40), event: "push", status: "completed", conclusion: "success", created_at: "2020-01-01T00:00:00Z", html_url: "https://x/1" },
    ],
  });
  const run = await findWorkflowRun("dutchbase", "va-jobs-platform", { sha: "a".repeat(40), branch: "master", event: "push", createdAfter: "2026-01-01T00:00:00Z" });
  expect(run).toBeNull();
});

test("findWorkflowRun accepts a PostgreSQL Date timestamp", async () => {
  mockFetchOnce(200, {
    workflow_runs: [
      { id: 2, name: "CI", head_branch: "master", head_sha: "a".repeat(40), event: "push", status: "completed", conclusion: "success", created_at: "2026-01-02T00:01:00Z", html_url: "https://x/2" },
      { id: 1, name: "CI", head_branch: "master", head_sha: "a".repeat(40), event: "push", status: "completed", conclusion: "success", created_at: "2026-01-01T23:59:00Z", html_url: "https://x/1" },
    ],
  });
  const run = await findWorkflowRun("dutchbase", "va-jobs-platform", {
    sha: "a".repeat(40), branch: "master", event: "push", createdAfter: new Date("2026-01-02T00:00:00Z"),
  });
  expect(run?.id).toBe(2);
});

test("findWorkflowRun selects the newest run containing every required job", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ workflow_runs: [
      { id: 2, workflow_id: 22, name: "Docs", head_branch: "master", head_sha: "a".repeat(40), event: "push", status: "completed", conclusion: "success", created_at: "2026-01-02T00:02:00Z", html_url: "https://x/2" },
      { id: 1, workflow_id: 11, name: "Deploy", head_branch: "master", head_sha: "a".repeat(40), event: "push", status: "completed", conclusion: "success", created_at: "2026-01-02T00:01:00Z", html_url: "https://x/1" },
    ] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [{ name: "docs", status: "completed", conclusion: "success", html_url: "https://x/docs" }] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [{ name: "docker-image", status: "completed", conclusion: "success", html_url: "https://x/docker" }] }), { status: 200 }));

  const run = await findWorkflowRun("dutchbase", "va-jobs-platform", {
    sha: "a".repeat(40), branch: "master", event: "push", requiredJobs: ["docker-image"],
  });

  expect(run?.id).toBe(1);
});

test("findWorkflowRun ignores an unrelated queued workflow ahead of the required workflow", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ workflow_runs: [
      { id: 2, workflow_id: 22, name: "Docs", head_branch: "master", head_sha: "a".repeat(40), event: "push", status: "queued", conclusion: null, created_at: "2026-01-02T00:02:00Z", html_url: "https://x/2" },
      { id: 1, workflow_id: 11, name: "Deploy", head_branch: "master", head_sha: "a".repeat(40), event: "push", status: "completed", conclusion: "success", created_at: "2026-01-02T00:01:00Z", html_url: "https://x/1" },
    ] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [{ name: "docker-image", status: "completed", conclusion: "success", html_url: "https://x/docker" }] }), { status: 200 }));

  const run = await findWorkflowRun("dutchbase", "va-jobs-platform", {
    sha: "a".repeat(40), branch: "master", event: "push", requiredJobs: ["docker-image"],
  });

  expect(run?.id).toBe(1);
});

test("findWorkflowRun selects the newest queued rerun of the job-matched workflow identity", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ workflow_runs: [
      { id: 3, workflow_id: 22, name: "Docs", head_branch: "master", head_sha: "a".repeat(40), event: "push", status: "queued", conclusion: null, created_at: "2026-01-02T00:03:00Z", html_url: "https://x/3" },
      { id: 2, workflow_id: 11, run_attempt: 2, name: "Deploy", head_branch: "master", head_sha: "a".repeat(40), event: "push", status: "queued", conclusion: null, created_at: "2026-01-02T00:02:00Z", html_url: "https://x/2" },
      { id: 1, workflow_id: 11, run_attempt: 1, name: "Deploy", head_branch: "master", head_sha: "a".repeat(40), event: "push", status: "completed", conclusion: "success", created_at: "2026-01-02T00:01:00Z", html_url: "https://x/1" },
    ] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [{ name: "docker-image", status: "completed", conclusion: "success", html_url: "https://x/docker" }] }), { status: 200 }));

  const run = await findWorkflowRun("dutchbase", "va-jobs-platform", {
    sha: "a".repeat(40), branch: "master", event: "push", requiredJobs: ["docker-image"],
  });

  expect(run?.id).toBe(2);
});

test("findWorkflowRun searches a bounded second page for the required workflow jobs", async () => {
  const unrelated = Array.from({ length: 20 }, (_, index) => ({
    id: 1000 + index, workflow_id: 22, name: "Docs", head_branch: "master", head_sha: "a".repeat(40), event: "push",
    status: "completed", conclusion: "success", created_at: `2026-01-02T00:${String(index % 60).padStart(2, "0")}:00Z`, html_url: `https://x/${1000 + index}`,
  }));
  const fetchSpy = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ workflow_runs: unrelated }), { status: 200 }));
  for (const run of unrelated) {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [{ name: "docs", status: "completed", conclusion: "success", html_url: `${run.html_url}/job` }] }), { status: 200 }));
  }
  fetchSpy
    .mockResolvedValueOnce(new Response(JSON.stringify({ workflow_runs: [
      { id: 7, workflow_id: 11, name: "Deploy", head_branch: "master", head_sha: "a".repeat(40), event: "push", status: "completed", conclusion: "success", created_at: "2026-01-01T00:00:00Z", html_url: "https://x/7" },
    ] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [{ name: "docker-image", status: "completed", conclusion: "success", html_url: "https://x/docker" }] }), { status: 200 }));

  const run = await findWorkflowRun("dutchbase", "va-jobs-platform", {
    sha: "a".repeat(40), branch: "master", event: "push", requiredJobs: ["docker-image"],
  });

  expect(run?.id).toBe(7);
  expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("page=2"))).toBe(true);
});

test("findWorkflowRun fails closed when a queued run has no jobs or workflow identity", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ workflow_runs: [
      { id: 2, name: "Deploy", head_branch: "master", head_sha: "a".repeat(40), event: "push", status: "queued", conclusion: null, created_at: "2026-01-02T00:02:00Z", html_url: "https://x/2" },
    ] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [] }), { status: 200 }));

  const run = await findWorkflowRun("dutchbase", "va-jobs-platform", {
    sha: "a".repeat(40), branch: "master", event: "push", requiredJobs: ["docker-image"],
  });

  expect(run).toBeNull();
});

test("getWorkflowRunJobs maps job name/status/conclusion", async () => {
  mockFetchOnce(200, { jobs: [{ name: "docker-image", status: "completed", conclusion: "success", html_url: "https://x/job/1" }] });
  const jobs = await getWorkflowRunJobs("dutchbase", "va-jobs-platform", 123);
  expect(jobs).toEqual([{ name: "docker-image", status: "completed", conclusion: "success", htmlUrl: "https://x/job/1" }]);
});

test("getWorkflowRunJobs searches later bounded pages", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    name: `job-${index}`, status: "completed", conclusion: "success", html_url: `https://x/job/${index}`,
  }));
  const fetchSpy = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: firstPage }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [{ name: "docker-image", status: "completed", conclusion: "success", html_url: "https://x/docker" }] }), { status: 200 }));

  const jobs = await getWorkflowRunJobs("dutchbase", "va-jobs-platform", 123);

  expect(jobs).toHaveLength(101);
  expect(jobs.at(-1)?.name).toBe("docker-image");
  expect(fetchSpy.mock.calls[1][0]).toContain("page=2");
});

test("getWorkflowRunJobs fails closed when every bounded page is full", async () => {
  const fullPage = Array.from({ length: 100 }, (_, index) => ({
    name: `job-${index}`, status: "completed", conclusion: "success", html_url: `https://x/job/${index}`,
  }));
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: fullPage }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: fullPage }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: fullPage }), { status: 200 }));

  await expect(getWorkflowRunJobs("dutchbase", "va-jobs-platform", 123))
    .rejects.toMatchObject({ code: "incomplete_response" });
});

test("compareCommits maps GitHub's status field", async () => {
  mockFetchOnce(200, { status: "ahead", ahead_by: 3, behind_by: 0 });
  const cmp = await compareCommits("dutchbase", "va-jobs-platform", "b".repeat(40), "a".repeat(40));
  expect(cmp).toEqual({ status: "ahead", aheadBy: 3, behindBy: 0 });
});
