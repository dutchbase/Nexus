import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildExecutionArguments,
  buildPlanningArguments,
  createExecutionSandboxSettings,
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
  executionDirectory: "/execution",
  readOnlyPaths: ["/prompt", "/skills"],
  logPath: "/log",
  timeoutMs: 1000,
  onEvent: async () => undefined,
};

test("writes fail-closed workspace-only sandbox settings for execution", async () => {
  const settingsDirectory = await mkdtemp(path.join(tmpdir(), "claude-runner-test-"));
  const { settingsFile } = await createExecutionSandboxSettings(executionInvocation, settingsDirectory);
  try {
    const settings = JSON.parse(await readFile(settingsFile, "utf8"));

    expect(settings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: ["/execution"],
        denyRead: ["~/"],
        allowRead: ["/execution", "/prompt", "/skills"],
      },
      credentials: {
        envVars: [
          { name: "GITHUB_TOKEN", mode: "deny" },
          { name: "GH_TOKEN", mode: "deny" },
          { name: "DATABASE_URL", mode: "deny" },
        ],
      },
      network: { allowedDomains: ["api.anthropic.com"], strictAllowlist: true },
    });
    expect(buildExecutionArguments(executionInvocation, settingsFile)).toContain(settingsFile);
  } finally {
    await rm(settingsDirectory, { recursive: true, force: true });
  }
});

describe("buildPlanningArguments", () => {
  test("uses the supplied restricted tool list", () => {
    expect(buildPlanningArguments({ ...invocation, tools: ["Read", "Glob", "Grep"] })).toContain("Read,Glob,Grep");
  });

  test("keeps Bash in the default tool list", () => {
    expect(buildPlanningArguments(invocation)).toContain("Read,Glob,Grep,Bash");
  });
});

test("enables local execution while denying publication and destructive shell commands", () => {
  const args = buildExecutionArguments(executionInvocation, "/settings");

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
