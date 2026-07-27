export type PullRequestBodyInput = {
  ticketNumber: string;
  ticketTitle: string;
  project: string;
  problemSummary: string;
  approvedPlanSummary: string;
  model: string;
  reasoningLevel: string;
  appliedSkills: string[];
  changedFiles: string[];
  validationResults: Array<{ check: string; status: "passed" | "skipped"; detail?: string }>;
  knownLimitations: string;
  planHash: string;
  executionRunId: string;
  internalTicketUrl: string;
};

function bullets(values: string[], empty = "None") {
  return values.length ? values.map((value) => `- ${value}`).join("\n") : `- ${empty}`;
}

export function buildPullRequestBody(input: PullRequestBodyInput) {
  const validation = input.validationResults.map(
    (result) => `- ${result.check}: ${result.status}${result.detail ? ` — ${result.detail}` : ""}`,
  );
  return [
    "## Ticket",
    `- Number: ${input.ticketNumber}`,
    `- Title: ${input.ticketTitle}`,
    `- Project: ${input.project}`,
    `- Internal ticket: ${input.internalTicketUrl}`,
    "",
    "## Problem summary",
    input.problemSummary || "No additional problem summary provided.",
    "",
    "## Approved plan summary",
    input.approvedPlanSummary || "See the approved plan on the internal ticket.",
    "",
    "## Execution",
    `- Model: ${input.model}`,
    `- Reasoning level: ${input.reasoningLevel}`,
    `- Plan hash: ${input.planHash}`,
    `- Execution run ID: ${input.executionRunId}`,
    "",
    "## Applied skills",
    bullets(input.appliedSkills),
    "",
    "## Changed files",
    bullets(input.changedFiles),
    "",
    "## Validation results",
    validation.length ? validation.join("\n") : "- No validation checks recorded.",
    "",
    "## Known limitations",
    input.knownLimitations || "None known.",
    "",
    "## Human review checklist",
    "- [ ] Confirm the implementation matches the approved plan.",
    "- [ ] Review security-sensitive and protected-path changes.",
    "- [ ] Confirm validation evidence and CI checks.",
    "- [ ] Verify known limitations are acceptable.",
  ].join("\n");
}
