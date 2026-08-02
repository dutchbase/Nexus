export type PrReviewPromptVars = {
  superpowersCodeReviewer: string;
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
    "superpowers.code-reviewer": vars.superpowersCodeReviewer,
    "project.name": JSON.stringify(vars.project.name),
    "pr.title": JSON.stringify(vars.pr.title),
    "pr.author": JSON.stringify(vars.pr.author),
    "pr.head_branch": JSON.stringify(vars.pr.head_branch),
    "pr.base_branch": JSON.stringify(vars.pr.base_branch),
    "pr.body": JSON.stringify(vars.pr.body ?? ""),
    "pr.diff": JSON.stringify(vars.pr.diff),
  };
}

export function renderPrReviewPrompt(template: string, vars: PrReviewPromptVars): string {
  const values = flatten(vars);
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, key: string) => values[key] ?? _match);
}

export class PrReviewVerdictError extends Error {}

export function parsePrReviewVerdict(markdown: string): { verdict: "approved" | "rejected"; summary: string } {
  const matches = [...markdown.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!matches.length) {
    throw new PrReviewVerdictError("No JSON verdict block found in review output");
  }
  if (matches.length !== 1) {
    throw new PrReviewVerdictError("Review output must contain exactly one JSON verdict block");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(matches[0][1]);
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
  return { verdict: obj.verdict, summary: obj.summary.trim() };
}
