import type { WorkflowRunSummary, WorkflowJobSummary, CommitComparison, ImageExistenceDetailedResult } from "../../github-provider/src/index.ts";

export type ActionsPreflightInput = {
  masterWorkflowRun: WorkflowRunSummary | null;
  masterWorkflowJobs: WorkflowJobSummary[];
  dockerImageJobName: string;
  ghcr: ImageExistenceDetailedResult; // advisory only — never affects `eligible`
};
export type ActionsPreflightResult = { eligible: boolean; reasons: string[]; dockerImageJobConclusion: string | null };

export function evaluateActionsPreflight(input: ActionsPreflightInput): ActionsPreflightResult {
  const reasons: string[] = [];
  if (!input.masterWorkflowRun) {
    return { eligible: false, reasons: ["master_workflow_not_found"], dockerImageJobConclusion: null };
  }
  if (input.masterWorkflowRun.status !== "completed") {
    return { eligible: false, reasons: ["master_workflow_pending"], dockerImageJobConclusion: null };
  }
  if (input.masterWorkflowRun.conclusion !== "success") {
    reasons.push("master_workflow_failed");
  }
  const dockerJob = input.masterWorkflowJobs.find((job) => job.name === input.dockerImageJobName);
  if (!dockerJob) {
    reasons.push("docker_image_job_missing");
  } else if (dockerJob.status !== "completed") {
    reasons.push("docker_image_job_pending");
  } else if (dockerJob.conclusion !== "success") {
    reasons.push("docker_image_job_failed");
  }
  return { eligible: reasons.length === 0, reasons, dockerImageJobConclusion: dockerJob?.conclusion ?? null };
}

export function computeDivergence(comparison: CommitComparison | null): "up_to_date" | "behind_master" | "diverged" | "unavailable" {
  if (!comparison) return "unavailable";
  if (comparison.status === "identical") return "up_to_date";
  if (comparison.status === "ahead") return "behind_master"; // base(production)...head(master): master ahead of production
  if (comparison.status === "diverged") return "diverged";
  return "unavailable"; // "behind" (production ahead of master) shouldn't occur for a ref-pointer branch; treat as unavailable rather than guess
}
