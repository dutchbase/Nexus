export type PrReviewPromptVars = {
  project: { name: string };
  pr: {
    title: string;
    author: string;
    head_branch: string;
    base_branch: string;
    body: string;
    diff: string;
  };
};

function flatten(vars: PrReviewPromptVars): Record<string, string> {
  return {
    "project.name": vars.project.name,
    "pr.title": vars.pr.title,
    "pr.author": vars.pr.author,
    "pr.head_branch": vars.pr.head_branch,
    "pr.base_branch": vars.pr.base_branch,
    "pr.body": vars.pr.body ?? "",
    "pr.diff": vars.pr.diff,
  };
}

export function renderPrReviewPrompt(template: string, vars: PrReviewPromptVars): string {
  const values = flatten(vars);
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, key: string) => values[key] ?? "");
}

export class PrReviewVerdictError extends Error {}

export function parsePrReviewVerdict(markdown: string): { verdict: "approved" | "rejected"; summary: string } {
  const matches = [...markdown.matchAll(/```json\s*([\s\S]*?)```/g)];
  const last = matches[matches.length - 1];
  if (!last) {
    throw new PrReviewVerdictError("No JSON verdict block found in review output");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(last[1]);
  } catch {
    throw new PrReviewVerdictError("Verdict JSON block is not valid JSON");
  }
  const obj = parsed as { verdict?: unknown; summary?: unknown };
  if (obj.verdict !== "approved" && obj.verdict !== "rejected") {
    throw new PrReviewVerdictError(`Verdict must be "approved" or "rejected", got: ${String(obj.verdict)}`);
  }
  if (typeof obj.summary !== "string" || obj.summary.trim() === "") {
    throw new PrReviewVerdictError("Verdict summary must be a non-empty string");
  }
  return { verdict: obj.verdict, summary: obj.summary };
}
