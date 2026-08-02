import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { buildExecutionArguments, buildPlanningArguments, invokePlanningClaude, summarizeClaudeFailure, type ExecutionInvocation, type PlanningInvocation } from "./index.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

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

  test("loads all materialized skills as session plugins without enabling Agent", () => {
    const args = buildPlanningArguments({ ...invocation, pluginDirectories: ["/plugin-a", "/plugin-b"] });
    expect(args).toContain("Read,Glob,Grep,Bash,Skill");
    expect(args).not.toContain("Agent");
    expect(args).not.toContain("--add-dir");
    expect(args).toEqual(expect.arrayContaining(["--plugin-dir", "/plugin-a", "--plugin-dir", "/plugin-b"]));
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
    expect(args).not.toContain("--add-dir");
    expect(args).toEqual(expect.arrayContaining(["--plugin-dir", "/plugin", "--agents"]));
    const agents = JSON.parse(args[args.indexOf("--agents") + 1]);
    expect(agents).toMatchObject({
      "dcc-mechanical": { model: "haiku" },
      "dcc-implementer": { model: "model" },
      "dcc-repair": { model: "model" },
      "dcc-reviewer": { model: "model", tools: ["Read", "Glob", "Grep"] },
    });
    for (const agent of Object.values(agents) as { disallowedTools: string[] }[]) {
      expect(agent.disallowedTools).toEqual(expect.arrayContaining([
        "Bash(git commit *)", "Bash(git push *)", "Bash(git merge *)", "Bash(gh pr create *)",
      ]));
    }
  });
});

test("invokes Claude with a materialized local skill plugin", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "claude-runner-"));
  directories.push(root);
  const plugin = path.join(root, "dcc-local");
  const bin = path.join(root, "bin");
  await mkdir(path.join(plugin, ".claude-plugin"), { recursive: true });
  await mkdir(path.join(plugin, "skills", "local"), { recursive: true });
  await mkdir(bin);
  await writeFile(path.join(plugin, ".claude-plugin", "plugin.json"), '{"name":"dcc-local"}\n');
  await writeFile(path.join(plugin, "skills", "local", "SKILL.md"), "# Local\n");
  await writeFile(path.join(bin, "claude"), `#!/bin/sh
for arg in "$@"; do
  if [ "$previous" = "--plugin-dir" ]; then plugin="$arg"; fi
  previous="$arg"
done
test -f "$plugin/.claude-plugin/plugin.json" && test -f "$plugin/skills/local/SKILL.md" || exit 2
printf '%s\\n' '{"type":"result","subtype":"success","result":"# Plan","session_id":"session"}'
`);
  await chmod(path.join(bin, "claude"), 0o755);
  await expect(invokePlanningClaude({
    ...invocation,
    skillBundleDir: undefined,
    pluginDirectories: [plugin],
    claudeExecutable: path.join(bin, "claude"),
    workingDirectory: root,
  })).resolves.toMatchObject({ markdown: "# Plan" });
});

test("summarizes a Bash denial from Claude's max-turn payload", () => {
  expect(summarizeClaudeFailure(
    '{"type":"result","subtype":"error_max_turns","errors":["Reached maximum number of turns (5)"],"permission_denials":[{"tool_name":"Bash"}]}',
    "",
  )).toBe("Reached maximum number of turns (5) Bash access was denied; the review did not complete.");
});
