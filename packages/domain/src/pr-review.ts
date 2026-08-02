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
  const json = (value: string) => JSON.stringify(value).replaceAll("<", "\\u003c");
  return {
    "superpowers.code-reviewer": vars.superpowersCodeReviewer,
    "project.name": json(vars.project.name),
    "pr.title": json(vars.pr.title),
    "pr.author": json(vars.pr.author),
    "pr.head_branch": json(vars.pr.head_branch),
    "pr.base_branch": json(vars.pr.base_branch),
    "pr.body": json(vars.pr.body ?? ""),
    "pr.diff": json(vars.pr.diff),
  };
}

export function renderPrReviewPrompt(template: string, vars: PrReviewPromptVars): string {
  const values = flatten(vars);
  const rendered = template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, key: string) => values[key] ?? _match);
  return /\{\{\s*superpowers\.code-reviewer\s*\}\}/.test(template)
    ? rendered
    : `${rendered}\n\n## Required immutable review rubric\n\n${vars.superpowersCodeReviewer}`;
}

export class PrReviewVerdictError extends Error {}

export function reviewedHeadShaForMerge(
  mode: "review_only" | "review_and_merge",
  verdict: "approved" | "rejected",
  reviewedHeadSha: string,
) {
  return mode === "review_and_merge" && verdict === "approved" ? reviewedHeadSha : null;
}

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
