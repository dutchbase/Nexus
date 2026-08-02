import { describe, expect, test } from "vitest";
import { buildExecutionArguments, buildPlanningArguments, summarizeClaudeFailure, type ExecutionInvocation, type PlanningInvocation } from "./index.ts";

const invocation: PlanningInvocation = {
  task: "Review this", sessionId: "session", model: "model", effort: "low", promptFile: "/prompt",
  skillBundleDir: "/skills", workingDirectory: "/work", maxTurns: 5, oauthToken: "token",
};

describe("buildPlanningArguments", () => {
  test("uses the supplied restricted tool list", () => {
    expect(buildPlanningArguments({ ...invocation, tools: ["Read", "Glob", "Grep"] })).toContain("Read,Glob,Grep");
  });

  test("keeps Bash in the default tool list", () => {
    expect(buildPlanningArguments(invocation)).toContain("Read,Glob,Grep,Bash,Skill");
  });

  test("loads local skills and plugins without enabling Agent", () => {
    const args = buildPlanningArguments({ ...invocation, pluginDirectories: ["/plugin-a", "/plugin-b"] });
    expect(args).toContain("Read,Glob,Grep,Bash,Skill");
    expect(args).not.toContain("Agent");
    expect(args).toEqual(expect.arrayContaining(["--add-dir", "/skills", "--plugin-dir", "/plugin-a", "--plugin-dir", "/plugin-b"]));
  });
});

describe("buildExecutionArguments", () => {
  test("enables skills and agents with session-local role definitions", () => {
    const args = buildExecutionArguments({
      ...invocation,
      pluginDirectories: ["/plugin"],
      logPath: "/log",
      timeoutMs: 1,
      onEvent: async () => undefined,
    } satisfies ExecutionInvocation);
    expect(args).toContain("Read,Glob,Grep,Edit,Write,Bash,Skill,Agent");
    expect(args).toEqual(expect.arrayContaining(["--add-dir", "/skills", "--plugin-dir", "/plugin", "--agents"]));
    const agents = JSON.parse(args[args.indexOf("--agents") + 1]);
    expect(agents).toMatchObject({
      "dcc-mechanical": { model: "haiku" },
      "dcc-implementer": { model: "model" },
      "dcc-repair": { model: "model" },
      "dcc-reviewer": { model: "model", tools: ["Read", "Glob", "Grep"] },
    });
  });
});

test("summarizes a Bash denial from Claude's max-turn payload", () => {
  expect(summarizeClaudeFailure(
    '{"type":"result","subtype":"error_max_turns","errors":["Reached maximum number of turns (5)"],"permission_denials":[{"tool_name":"Bash"}]}',
    "",
  )).toBe("Reached maximum number of turns (5) Bash access was denied; the review did not complete.");
});
