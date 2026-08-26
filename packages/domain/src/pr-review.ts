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

export type PrReviewVerdictErrorCode =
  | "missing_verdict"
  | "ambiguous_verdict"
  | "invalid_verdict_json"
  | "invalid_verdict_value"
  | "invalid_verdict_summary";

export class PrReviewVerdictError extends Error {
  constructor(message: string, readonly code: PrReviewVerdictErrorCode) {
    super(message);
  }
}

export function parsePrReviewVerdict(markdown: string): { verdict: "approved" | "rejected"; summary: string } {
  // Scan fenced JSON blocks last-to-first and accept the first one that is a
  // valid verdict. Requiring global uniqueness threw away fully-completed
  // reviews whenever the model quoted the format or embedded a JSON snippet
  // in its findings.
  const matches = [...markdown.matchAll(/```json\s*([\s\S]*?)```/g)];
  let lastError: PrReviewVerdictError | null = null;
  for (const match of matches.reverse()) {
    try {
      return validateVerdictJson(match[1]);
    } catch (error) {
      if (error instanceof PrReviewVerdictError) { lastError = error; continue; }
      throw error;
    }
  }
  if (!matches.length) {
    throw new PrReviewVerdictError("No JSON verdict block found in review output", "missing_verdict");
  }
  throw lastError ?? new PrReviewVerdictError("No valid verdict block found", "invalid_verdict_json");
}

function validateVerdictJson(raw: string): { verdict: "approved" | "rejected"; summary: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PrReviewVerdictError("Verdict JSON block is not valid JSON", "invalid_verdict_json");
  }
  const obj = parsed && typeof parsed === "object" ? parsed as { verdict?: unknown; summary?: unknown } : {};
  if (obj.verdict !== "approved" && obj.verdict !== "rejected") {
    throw new PrReviewVerdictError(`Verdict must be "approved" or "rejected", got: ${String(obj.verdict)}`, "invalid_verdict_value");
  }
  if (typeof obj.summary !== "string" || obj.summary.trim() === "") {
    throw new PrReviewVerdictError("Verdict summary must be a non-empty string", "invalid_verdict_summary");
  }
  return { verdict: obj.verdict, summary: obj.summary.trim() };
}
