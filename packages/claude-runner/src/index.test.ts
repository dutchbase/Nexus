import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync, writeSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
import {
  buildExecutionArguments,
  buildPlanningArguments,
  createExecutionSandboxSettings,
  invokeExecutionClaude,
  isClaudeSandboxVersionSupported,
  summarizeClaudeFailure,
  type ExecutionInvocation,
  type PlanningInvocation,
} from "./index.ts";

afterEach(() => spawnMock.mockReset());

const invocation: PlanningInvocation = {
  task: "Review this", sessionId: "session", model: "model", effort: "low", promptFile: "/prompt",
  skillBundleDir: "/skills", workingDirectory: "/work", maxTurns: 5, oauthToken: "token",
};

const executionInvocation: ExecutionInvocation = {
  ...invocation,
  promptFile: ".git/dcc-support/execution-prompt.md", skillBundleDir: ".git/dcc-support/skills",
  executionDirectory: "/execution",
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
        denyRead: ["/"],
        allowRead: ["/execution"],
      },
      credentials: {
        envVars: [
          { name: "GITHUB_TOKEN", mode: "deny" },
          { name: "GH_TOKEN", mode: "deny" },
          { name: "DATABASE_URL", mode: "deny" },
          { name: "CLAUDE_CODE_OAUTH_TOKEN", mode: "deny" },
        ],
      },
      network: { allowedDomains: ["api.anthropic.com"], strictAllowlist: true },
    });
    expect(buildExecutionArguments(executionInvocation, settingsFile)).toContain(settingsFile);
  } finally {
    await rm(settingsDirectory, { recursive: true, force: true });
  }
});

test("requires Claude versions that support strict sandbox allowlists", () => {
  expect(isClaudeSandboxVersionSupported("2.1.218")).toBe(false);
  expect(isClaudeSandboxVersionSupported("2.1.219")).toBe(true);
  expect(isClaudeSandboxVersionSupported("claude 2.2.0")).toBe(true);
  expect(isClaudeSandboxVersionSupported("unknown")).toBe(false);
});

test("spawns execution with isolated settings, environment, and cleanup", async () => {
  const runDirectory = await mkdtemp(path.join(tmpdir(), "claude-runner-execution-"));
  const captures: { args: string[]; env: NodeJS.ProcessEnv; settings: any; settingsFile: string }[] = [];
  spawnMock.mockImplementation((_command: string, args: string[], options: any) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
    if (args[0] === "--version") {
      writeSync(options.stdio[1], "2.1.219\n");
    } else {
      const settingsFile = args[args.indexOf("--settings") + 1]!;
      captures.push({ args, env: options.env, settings: JSON.parse(readFileSync(settingsFile, "utf8")), settingsFile });
    }
    queueMicrotask(() => child.emit("close", 0));
    return child as any;
  });
  try {
    await invokeExecutionClaude({
      ...executionInvocation,
      workingDirectory: runDirectory,
      executionDirectory: runDirectory,
      logPath: path.join(runDirectory, "execution.log"),
    });

    await invokeExecutionClaude({
      ...executionInvocation,
      workingDirectory: runDirectory,
      executionDirectory: runDirectory,
      logPath: path.join(runDirectory, "execution.log"),
    });

    const captured = captures[0]!;
    expect(captures).toHaveLength(2);
    expect(captures[0]!.settingsFile).not.toBe(captures[1]!.settingsFile);
    expect(captured.args).toContain("--setting-sources");
    expect(captured.args[captured.args.indexOf("--setting-sources") + 1]).toBe("");
    expect(captured.args).toContain("--strict-mcp-config");
    expect(captured.env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: "token",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    });
    expect(captured.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(captured.env).not.toHaveProperty("GH_TOKEN");
    expect(captured.env).not.toHaveProperty("DATABASE_URL");
    expect(captured.settings).toMatchObject({
      disableAllHooks: true,
      sandbox: { credentials: { envVars: expect.arrayContaining([{ name: "CLAUDE_CODE_OAUTH_TOKEN", mode: "deny" }]) } },
    });
    await expect(access(captured.settingsFile)).rejects.toThrow();
    await expect(access(captures[1]!.settingsFile)).rejects.toThrow();
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
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
  expect(args).toContain("Bash,Agent,Skill");
  expect(args[args.indexOf("--disallowedTools") + 1]?.split(",")).toEqual([
    "Read", "Glob", "Grep", "Edit", "Write",
    "Bash(git push *)", "Bash(git merge *)", "Bash(git reset *)", "Bash(git commit --amend *)",
    "Bash(git rebase *)", "Bash(git checkout *)", "Bash(git switch *)",
    "Bash(gh *)", "Bash(sudo *)", "Bash(rm -rf /)", "Bash(rm -rf ~)",
  ]);
  expect(args).toContain(".git/dcc-support/execution-prompt.md");
  expect(args).toContain(".git/dcc-support/skills");
  expect(args).not.toContain("/prompt");
  expect(args).not.toContain("/skills");
});

test("summarizes a Bash denial from Claude's max-turn payload", () => {
  expect(summarizeClaudeFailure(
    '{"type":"result","subtype":"error_max_turns","errors":["Reached maximum number of turns (5)"],"permission_denials":[{"tool_name":"Bash"}]}',
    "",
  )).toBe("Reached maximum number of turns (5) Bash access was denied; the review did not complete.");
});
