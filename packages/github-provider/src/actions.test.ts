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

test("getWorkflowRunJobs maps job name/status/conclusion", async () => {
  mockFetchOnce(200, { jobs: [{ name: "docker-image", status: "completed", conclusion: "success", html_url: "https://x/job/1" }] });
  const jobs = await getWorkflowRunJobs("dutchbase", "va-jobs-platform", 123);
  expect(jobs).toEqual([{ name: "docker-image", status: "completed", conclusion: "success", htmlUrl: "https://x/job/1" }]);
});

test("compareCommits maps GitHub's status field", async () => {
  mockFetchOnce(200, { status: "ahead", ahead_by: 3, behind_by: 0 });
  const cmp = await compareCommits("dutchbase", "va-jobs-platform", "b".repeat(40), "a".repeat(40));
  expect(cmp).toEqual({ status: "ahead", aheadBy: 3, behindBy: 0 });
});
