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

// The injected code-review rubric (prompts/global/code-reviewer.md) is synced
// verbatim from the upstream superpowers:requesting-code-review skill, which
// expects a Bash-enabled reviewer to fetch its own diff via `git diff
// {BASE_SHA}..{HEAD_SHA}` and a caller to fill {DESCRIPTION}/{PLAN_REFERENCE}
// placeholders. The automated PR-review flow supplies the diff inline instead
// and has no Bash tool, so left unsanitized this section sent the model literal
// `{BASE_SHA}` placeholders plus an instruction to run a tool it doesn't have —
// turns burned reconciling that, not reviewing the diff (root cause of the
// "Reached maximum number of turns" failures; see docs/superpowers/plans).
const GIT_RANGE_SECTION = /\n## Git Range to Review\n[\s\S]*?(?=\n## |$)/;

const RUBRIC_PLACEHOLDER_FALLBACKS: Record<string, string> = {
  WHAT_WAS_IMPLEMENTED: "the supplied pull request diff and checked-out repository",
  PLAN_OR_REQUIREMENTS: "the pull request's stated intent (title and description above) — no separate plan document applies",
  DESCRIPTION: "See the pull request title, description, and diff already supplied above.",
  PLAN_REFERENCE: "Not applicable — this is an automated pull-request review with no separate plan document.",
};

export function sanitizeReviewRubricForPrReview(rubric: string): string {
  const withoutGitRange = rubric.replace(GIT_RANGE_SECTION, "");
  return withoutGitRange.replace(/\{([A-Z_]+)\}/g, (match, key: string) => RUBRIC_PLACEHOLDER_FALLBACKS[key] ?? match);
}

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
  const sanitizedRubric = sanitizeReviewRubricForPrReview(vars.superpowersCodeReviewer);
  const values = flatten({ ...vars, superpowersCodeReviewer: sanitizedRubric });
  const rendered = template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, key: string) => values[key] ?? _match);
  return /\{\{\s*superpowers\.code-reviewer\s*\}\}/.test(template)
    ? rendered
    : `${rendered}\n\n## Required immutable review rubric\n\n${sanitizedRubric}`;
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
