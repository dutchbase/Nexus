import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { buildExecutionArguments, buildPlanningArguments, invokeExecutionClaude, invokePlanningClaude, summarizeClaudeFailure, type ExecutionInvocation, type PlanningInvocation } from "./index.ts";

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

  test("loads the bundle layout and all materialized skills as session plugins without enabling Agent", () => {
    const args = buildPlanningArguments({ ...invocation, pluginDirectories: ["/plugin-a", "/plugin-b"] });
    expect(args).toContain("Read,Glob,Grep,Bash,Skill");
    expect(args).not.toContain("Agent");
    expect(args).toEqual(expect.arrayContaining(["--add-dir", "/skills"]));
    expect(args).toEqual(expect.arrayContaining(["--plugin-dir", "/plugin-a", "--plugin-dir", "/plugin-b"]));
  });
});

describe("buildExecutionArguments", () => {
  test("enables skills and agents with session-local role definitions", () => {
    const args = buildExecutionArguments({
      ...invocation,
      pluginDirectories: ["/plugin"],
      guardPath: "/immutable/bash-guard.mjs",
      logPath: "/log",
      timeoutMs: 1,
      onEvent: async () => undefined,
    } satisfies ExecutionInvocation);
    expect(args).toContain("Read,Glob,Grep,Skill,Agent");
    expect(args).not.toContain("Read,Glob,Grep,Edit,Write,Bash,Skill,Agent");
    expect(args).toEqual(expect.arrayContaining(["--add-dir", "/skills", "--plugin-dir", "/plugin", "--agents"]));
    const agents = JSON.parse(args[args.indexOf("--agents") + 1]);
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    expect(agents).toMatchObject({
      "dcc-mechanical": { model: "haiku" },
      "dcc-implementer": { model: "model" },
      "dcc-repair": { model: "model" },
      "dcc-reviewer": { model: "model", tools: ["Read", "Glob", "Grep"] },
    });
    for (const name of ["dcc-mechanical", "dcc-implementer", "dcc-repair"]) {
      const agent = agents[name] as { tools: string[]; hooks?: { PreToolUse?: unknown[] } };
      expect(agent.tools).toEqual(expect.arrayContaining([
        "Read", "Glob", "Grep", "Edit", "Write", "Bash",
      ]));
      expect(agent.tools).not.toContain("Bash(pnpm test *)");
      expect(agent.hooks?.PreToolUse).toEqual([expect.objectContaining({ matcher: "Bash" })]);
    }
    const reviewer = agents["dcc-reviewer"] as { tools: string[] };
    expect(reviewer.tools).not.toContain("Bash");
    expect(settings.hooks.PreToolUse).toEqual(expect.arrayContaining([
      expect.objectContaining({ matcher: "Agent" }),
    ]));
    expect(JSON.stringify(settings)).toContain("/immutable/bash-guard.mjs");

  });
});

test("invokes Claude with the materialized local layout and plugin", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "claude-runner-"));
  directories.push(root);
  const bundle = path.join(root, "bundle");
  const plugin = path.join(bundle, "plugins", "dcc-local");
  const bin = path.join(root, "bin");
  await mkdir(path.join(plugin, ".claude-plugin"), { recursive: true });
  await mkdir(path.join(plugin, "skills", "local"), { recursive: true });
  await mkdir(path.join(bundle, ".claude", "skills", "local"), { recursive: true });
  await mkdir(bin);
  await writeFile(path.join(plugin, ".claude-plugin", "plugin.json"), '{"name":"dcc-local"}\n');
  await writeFile(path.join(plugin, "skills", "local", "SKILL.md"), "# Local\n");
  await writeFile(path.join(bundle, ".claude", "skills", "local", "SKILL.md"), "# Local\n");
  await writeFile(path.join(bin, "claude"), `#!/bin/sh
for arg in "$@"; do
  if [ "$previous" = "--plugin-dir" ]; then plugin="$arg"; fi
  if [ "$previous" = "--add-dir" ]; then bundle="$arg"; fi
  previous="$arg"
done
test -f "$bundle/.claude/skills/local/SKILL.md" && test -f "$plugin/.claude-plugin/plugin.json" && test -f "$plugin/skills/local/SKILL.md" || exit 2
printf '%s\\n' '{"type":"result","subtype":"success","result":"# Plan","session_id":"session"}'
`);
  await chmod(path.join(bin, "claude"), 0o755);
  await expect(invokePlanningClaude({
    ...invocation,
    skillBundleDir: bundle,
    pluginDirectories: [plugin],
    claudeExecutable: path.join(bin, "claude"),
    workingDirectory: root,
  })).resolves.toMatchObject({ markdown: "# Plan" });
});

test("invokes execution with a materialized guard outside the worktree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "claude-execution-"));
  directories.push(root);
  const bin = path.join(root, "bin");
  const capture = path.join(root, "settings.json");
  await mkdir(bin);
  const executable = path.join(bin, "claude");
  await writeFile(executable, `#!/bin/sh
for arg in "$@"; do
  if [ "$previous" = "--settings" ]; then settings="$arg"; fi
  previous="$arg"
done
printf '%s' "$settings" > ${JSON.stringify(capture)}
`);
  await chmod(executable, 0o755);
  await expect(invokeExecutionClaude({
    ...invocation,
    claudeExecutable: executable,
    workingDirectory: root,
    logPath: path.join(root, "run.log"),
    timeoutMs: 1_000,
    onEvent: async () => undefined,
  })).resolves.toMatchObject({ exitCode: 0 });
  const settings = JSON.parse(await (await import("node:fs/promises")).readFile(capture, "utf8"));
  const command = settings.hooks.PreToolUse[0].hooks[0].command;
  expect(command).toContain("/tmp/dcc-claude-guard-");
  expect(command).not.toContain(root);
});

test("summarizes a Bash denial from Claude's max-turn payload", () => {
  expect(summarizeClaudeFailure(
    '{"type":"result","subtype":"error_max_turns","errors":["Reached maximum number of turns (5)"],"permission_denials":[{"tool_name":"Bash"}]}',
    "",
  )).toBe("Reached maximum number of turns (5) Bash access was denied; the review did not complete.");
});
