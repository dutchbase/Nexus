# PR AI Review Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI PR reviews complete without attempting unnecessary Git commands, and show a short actionable error if Claude cannot return a verdict.

**Architecture:** Keep normal ticket-planning and conflict-resolution permissions unchanged. Add an optional planning-tool allowlist, use it only for the diff-only PR-review invocation to remove `Bash`, and distill Claude JSON error results before they reach the existing review-history UI.

**Tech Stack:** TypeScript, Node.js child processes, PostgreSQL-backed worker, Vitest.

## Global Constraints

- Work from a feature branch/worktree; do not commit, merge, or push directly on `master`/`main`.
- Do not add dependencies or a configurable AI-review turn limit: the supplied PR diff is sufficient and the existing five-turn ceiling remains the cost guard.
- AI review must remain non-merging unless `parsePrReviewVerdict()` returns `verdict: "approved"`; a failed review must not call `approveAndMergePullRequest()`.
- Preserve the current default tools (`Read,Glob,Grep,Bash`) for ticket planning and conflict resolution.

---

## File Structure

- Modify: `packages/claude-runner/src/index.ts` — accept a per-invocation planning tool list and turn Claude JSON failures into short text.
- Create: `packages/claude-runner/src/index.test.ts` — regression tests for the PR-review tool list and error summary.
- Modify: `apps/worker/src/worker.ts` — run diff-only PR review without `Bash` and state that it must return a verdict from the supplied diff.

### Task 1: Make the Claude planning runner configurable and readable on failure

**Files:**

- Modify: `packages/claude-runner/src/index.ts:60-97`
- Create: `packages/claude-runner/src/index.test.ts`

**Interfaces:**

- Consumes: `PlanningInvocation` supplied by planning, PR-review, and conflict-resolution worker jobs.
- Produces: `PlanningInvocation.tools?: string[]`, `buildPlanningArguments(input): string[]`, and `summarizeClaudeFailure(stdout: string, stderr: string): string`.

- [ ] **Step 1: Write the failing regression tests**

```ts
import { describe, expect, it } from "vitest";
import { buildPlanningArguments, summarizeClaudeFailure } from "./index.ts";

const invocation = {
  task: "Review PR #7",
  sessionId: "session-id",
  model: "sonnet",
  effort: "medium",
  promptFile: "/tmp/prompt.md",
  skillBundleDir: "/tmp/skills",
  workingDirectory: "/tmp/repo",
  maxTurns: 5,
  oauthToken: "token",
};

describe("Claude planning invocation", () => {
  it("uses a PR review's restricted tool list", () => {
    const args = buildPlanningArguments({ ...invocation, tools: ["Read", "Glob", "Grep"] });
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
  });

  it("summarizes Claude JSON failures without displaying the payload", () => {
    const detail = summarizeClaudeFailure(JSON.stringify({
      errors: ["Reached maximum number of turns (5)"],
      permission_denials: [{ tool_name: "Bash" }],
    }), "");
    expect(detail).toBe("Reached maximum number of turns (5) Bash access was denied; the review did not complete.");
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm exec vitest run packages/claude-runner/src/index.test.ts`

Expected: FAIL because `tools` is not accepted and `summarizeClaudeFailure` is not exported.

- [ ] **Step 3: Implement the minimum runner change**

```ts
export type PlanningInvocation = {
  // existing fields
  tools?: string[];
};

export function summarizeClaudeFailure(stdout: string, stderr: string) {
  if (stderr.trim()) return stderr.trim();
  try {
    const response = JSON.parse(stdout.trim());
    const errors = Array.isArray(response?.errors)
      ? response.errors.filter((value: unknown): value is string => typeof value === "string" && value.trim())
      : [];
    if (errors.length) {
      const bashDenied = Array.isArray(response?.permission_denials)
        && response.permission_denials.some((denial: any) => denial?.tool_name === "Bash");
      return `${errors.join(" ")}${bashDenied ? " Bash access was denied; the review did not complete." : ""}`;
    }
  } catch { /* use the generic message below */ }
  return "Claude review failed without a readable error message";
}

// In buildPlanningArguments:
"--permission-mode", "manual", "--tools", (input.tools ?? ["Read", "Glob", "Grep", "Bash"]).join(","),

// In invokePlanningClaude's non-zero-exit branch:
const detail = summarizeClaudeFailure(result.stdout, result.stderr);
```

Do not change `runClaude`, the command's JSON output format, or the success-path response validation.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm exec vitest run packages/claude-runner/src/index.test.ts`

Expected: PASS with both tests green.

- [ ] **Step 5: Commit the self-contained runner change**

```bash
git add packages/claude-runner/src/index.ts packages/claude-runner/src/index.test.ts
git commit -m "fix: constrain and clarify Claude PR reviews"
```

### Task 2: Restrict the diff-only PR-review agent

**Files:**

- Modify: `apps/worker/src/worker.ts:1074-1084`

**Interfaces:**

- Consumes: `invokePlanningClaude({ tools?: string[] })` from Task 1.
- Produces: a PR-review invocation that cannot request `Bash`; all later verdict parsing and conditional merge logic stay unchanged.

- [ ] **Step 1: Make the PR-review invocation use only read-only, non-shell tools**

Change only the `runPrAiReview()` call to `invokePlanningClaude()`:

```ts
task: `Review PR #${pullRequest.number} in ${pullRequest.repository} for merge safety using only the supplied PR description and diff. Do not inspect the repository or run commands; return the requested JSON verdict.`,
// existing sessionId, model, effort, promptFile, skillBundleDir, workingDirectory, maxTurns, oauthToken
tools: ["Read", "Glob", "Grep"],
```

Keep `maxTurns: 5`. The embedded diff and explicit response format are enough for the review; raising the limit would pay for retries of work the review does not need.

- [ ] **Step 2: Run the focused regression check**

Run: `pnpm exec vitest run packages/claude-runner/src/index.test.ts`

Expected: PASS. The runner constructs the non-shell tool list for this PR-review path and still keeps its default tool list for callers that omit `tools`.

- [ ] **Step 3: Perform one safe manual acceptance check in the deployed app**

From `/admin/pull-requests/vai-sit/7`, click **AI review** (not **AI review and approve**). Confirm the newest history entry becomes **APPROVED** or **REJECTED** with a review summary, and confirm it does not show raw JSON. If Claude fails for another reason, confirm the entry instead contains one short error sentence.

- [ ] **Step 4: Commit the worker wiring**

```bash
git add apps/worker/src/worker.ts packages/claude-runner/src/index.test.ts
git commit -m "fix: keep PR review within its supplied diff"
```

## Self-Review

- Spec coverage: Task 1 addresses the unreadable JSON error; Task 2 removes the demonstrated denied-`Bash` loop while retaining the five-turn cost ceiling and proves a failed review cannot merge because the existing merge call remains after successful verdict parsing.
- Placeholder scan: no unresolved work markers, generic testing directions, or undefined interfaces remain.
- Type consistency: `tools?: string[]` is defined on `PlanningInvocation`, read by `buildPlanningArguments`, and passed only from `runPrAiReview`.
