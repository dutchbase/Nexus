import { describe, expect, test } from "vitest";
import {
  buildExecutionArguments,
  buildPlanningArguments,
  summarizeClaudeFailure,
  type ExecutionInvocation,
  type PlanningInvocation,
} from "./index.ts";

const invocation: PlanningInvocation = {
  task: "Review this", sessionId: "session", model: "model", effort: "low", promptFile: "/prompt",
  skillBundleDir: "/skills", workingDirectory: "/work", maxTurns: 5, oauthToken: "token",
};

const executionInvocation: ExecutionInvocation = {
  ...invocation,
  logPath: "/log",
  timeoutMs: 1000,
  onEvent: async () => undefined,
};

describe("buildPlanningArguments", () => {
  test("uses the supplied restricted tool list", () => {
    expect(buildPlanningArguments({ ...invocation, tools: ["Read", "Glob", "Grep"] })).toContain("Read,Glob,Grep");
  });

  test("keeps Bash in the default tool list", () => {
    expect(buildPlanningArguments(invocation)).toContain("Read,Glob,Grep,Bash");
  });
});

test("enables local execution while denying publication and destructive shell commands", () => {
  const args = buildExecutionArguments(executionInvocation);

  expect(args).toContain("auto");
  expect(args).toContain("Read,Glob,Grep,Edit,Write,Bash,Agent,Skill");
  expect(args[args.indexOf("--disallowedTools") + 1]?.split(",")).toEqual([
    "Bash(git push *)", "Bash(git merge *)", "Bash(git reset *)", "Bash(git commit --amend *)",
    "Bash(git rebase *)", "Bash(git checkout *)", "Bash(git switch *)",
    "Bash(gh *)", "Bash(sudo *)", "Bash(rm -rf /)", "Bash(rm -rf ~)",
  ]);
});

test("summarizes a Bash denial from Claude's max-turn payload", () => {
  expect(summarizeClaudeFailure(
    '{"type":"result","subtype":"error_max_turns","errors":["Reached maximum number of turns (5)"],"permission_denials":[{"tool_name":"Bash"}]}',
    "",
  )).toBe("Reached maximum number of turns (5) Bash access was denied; the review did not complete.");
});
