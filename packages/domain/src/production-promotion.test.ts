import { expect, test } from "vitest";
import { evaluateActionsPreflight, computeDivergence } from "./production-promotion.ts";

const baseRun = { id: 1, name: "CI", headBranch: "master", headSha: "a".repeat(40), event: "push", status: "completed", conclusion: "success", createdAt: "2026-01-01T00:00:00Z", htmlUrl: "x" };

test("eligible when the master run succeeded and docker-image job succeeded, regardless of GHCR state", () => {
  const result = evaluateActionsPreflight({
    masterWorkflowRun: baseRun,
    masterWorkflowJobs: [{ name: "docker-image", status: "completed", conclusion: "success", htmlUrl: "x" }],
    dockerImageJobName: "docker-image",
    ghcr: { state: "unknown", reason: "rate limited" }, // GHCR failure must NOT block
  });
  expect(result.eligible).toBe(true);
  expect(result.dockerImageJobConclusion).toBe("success");
});

test("ineligible when no master workflow run was found", () => {
  const result = evaluateActionsPreflight({ masterWorkflowRun: null, masterWorkflowJobs: [], dockerImageJobName: "docker-image", ghcr: { state: "unknown" } });
  expect(result.eligible).toBe(false);
  expect(result.reasons).toContain("master_workflow_not_found");
});

test("ineligible when the master workflow run has not concluded", () => {
  const result = evaluateActionsPreflight({
    masterWorkflowRun: { ...baseRun, status: "in_progress", conclusion: null },
    masterWorkflowJobs: [], dockerImageJobName: "docker-image", ghcr: { state: "unknown" },
  });
  expect(result.eligible).toBe(false);
  expect(result.reasons).toContain("master_workflow_pending");
});

test("ineligible when the master workflow run failed", () => {
  const result = evaluateActionsPreflight({
    masterWorkflowRun: { ...baseRun, conclusion: "failure" },
    masterWorkflowJobs: [], dockerImageJobName: "docker-image", ghcr: { state: "unknown" },
  });
  expect(result.eligible).toBe(false);
  expect(result.reasons).toContain("master_workflow_failed");
});

test("ineligible when the docker-image job is missing from the run", () => {
  const result = evaluateActionsPreflight({
    masterWorkflowRun: baseRun, masterWorkflowJobs: [{ name: "lint", status: "completed", conclusion: "success", htmlUrl: "x" }],
    dockerImageJobName: "docker-image", ghcr: { state: "unknown" },
  });
  expect(result.eligible).toBe(false);
  expect(result.reasons).toContain("docker_image_job_missing");
});

test("ineligible when the docker-image job failed", () => {
  const result = evaluateActionsPreflight({
    masterWorkflowRun: baseRun, masterWorkflowJobs: [{ name: "docker-image", status: "completed", conclusion: "failure", htmlUrl: "x" }],
    dockerImageJobName: "docker-image", ghcr: { state: "unknown" },
  });
  expect(result.eligible).toBe(false);
  expect(result.reasons).toContain("docker_image_job_failed");
});

test("computeDivergence maps identical to up_to_date", () => {
  expect(computeDivergence({ status: "identical", aheadBy: 0, behindBy: 0 })).toBe("up_to_date");
});
test("computeDivergence maps ahead (master ahead of production) to behind_master", () => {
  expect(computeDivergence({ status: "ahead", aheadBy: 3, behindBy: 0 })).toBe("behind_master");
});
test("computeDivergence maps diverged to diverged", () => {
  expect(computeDivergence({ status: "diverged", aheadBy: 2, behindBy: 1 })).toBe("diverged");
});
test("computeDivergence maps a null comparison (compare API failed) to unavailable", () => {
  expect(computeDivergence(null)).toBe("unavailable");
});
