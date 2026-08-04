import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { assertExecutionSandboxVersion, buildExecutionArguments, buildPlanningArguments, createExecutionSandboxSettings, invokeExecutionClaude, invokePlanningClaude, isClaudeSandboxVersionSupported, parsePlanMarkdown, summarizeClaudeFailure, type ExecutionInvocation, type PlanningInvocation } from "./index.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const invocation: PlanningInvocation = {
  task: "Review this", sessionId: "session", model: "model", effort: "low", promptFile: "/prompt",
  skillBundleDir: "/skills", workingDirectory: "/work", maxTurns: 5, oauthToken: "token",
};
const guardPath = fileURLToPath(new URL("./bash-guard.mjs", import.meta.url));

function runConfiguredHook(command: string, toolName: string, toolInput: Record<string, unknown>, cwd = "/work") {
  return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command]);
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd }));
  });
}

const executionInvocation: ExecutionInvocation = {
  ...invocation,
  promptFile: ".git/dcc-support/execution-prompt.md", skillBundleDir: ".git/dcc-support/skills",
  executionDirectory: "/execution",
  logPath: "/log",
  timeoutMs: 1000,
  onEvent: async () => undefined,
};

const planSections = [
  "Implementation Plan", "Summary", "Problem Definition", "Current Behaviour", "Expected Behaviour",
  "Relevant Architecture", "Relevant Files", "Proposed Changes", "Implementation Steps",
  "Database or Migration Changes", "Testing Strategy", "Security Considerations",
  "Performance Considerations", "Risks and Edge Cases", "Rollback Strategy",
  "Acceptance Criteria Mapping", "Out of Scope", "Open Questions",
];

function planMarkdown(headings = planSections) {
  return headings.map((heading) => `## ${heading}\nContent`).join("\n\n");
}

describe("parsePlanMarkdown", () => {
  test("accepts semantic sections despite number, punctuation, level, and order variations", () => {
    const headings = [
      "##### 10) Testing Strategy:", "# Implementation Plan — DCC-1001", "### Relevant Files!",
      "#### 4 - Expected Behaviour", "## Summary", "###### Open Questions?", "# 2. Problem Definition",
      "### Relevant Architecture", "## 9: Database or Migration Changes", "#### Proposed Changes",
      "# 3) Current Behaviour", "##### Acceptance Criteria Mapping", "## 16. Out of Scope",
      "### Performance Considerations", "#### Implementation Steps", "# Security Considerations",
      "## 13. Risks and Edge Cases", "###### Rollback Strategy",
    ];

    const markdown = headings.map((heading) => `${heading}\nContent`).join("\n\n");
    expect(parsePlanMarkdown(markdown)).toBe(`${markdown}\n`);
  });

  test("accepts comma and em dash after leading section numbers with or without whitespace", () => {
    const headings = planSections.map((section, index) =>
      `## ${index + 1}${[", ", " — ", ",", "—"][index % 4]}${section}`,
    );
    const markdown = headings.map((heading) => `${heading}\nContent`).join("\n\n");

    expect(parsePlanMarkdown(markdown)).toBe(`${markdown}\n`);
  });

  test("reports missing semantic sections", () => {
    const markdown = planMarkdown(planSections.filter((heading) => heading !== "Rollback Strategy"));

    expect(() => parsePlanMarkdown(markdown)).toThrow("invalid_plan_structure: missing sections: Rollback Strategy");
  });

  test("reports duplicate semantic sections", () => {
    const markdown = planMarkdown([...planSections, "Summary"]);

    expect(() => parsePlanMarkdown(markdown)).toThrow("invalid_plan_structure: duplicate sections: Summary");
  });

  test("preserves legacy Markdown unchanged apart from its final newline", () => {
    const markdown = ["# Implementation Plan", ...planSections.slice(1).map((heading, index) => `## ${index + 1}. ${heading}`)].join("\n\n");

    expect(parsePlanMarkdown(markdown)).toBe(`${markdown}\n`);
  });
});

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
        denyRead: expect.arrayContaining(["/work/.git"]),
        allowRead: expect.arrayContaining([
          "/work", "/work/.git/dcc-support/execution-prompt.md", "/work/.git/dcc-support/skills",
        ]),
      },
      credentials: {
        envVars: expect.arrayContaining([
          { name: "GITHUB_TOKEN", mode: "deny" },
          { name: "GH_TOKEN", mode: "deny" },
          { name: "DATABASE_URL", mode: "deny" },
          { name: "CLAUDE_CODE_OAUTH_TOKEN", mode: "deny" },
        ]),
      },
      network: { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true },
    });
    expect(settings.permissions.allow).toEqual(expect.arrayContaining(["Edit(//work)", "Edit(//work/**)"]));
    expect(buildExecutionArguments(executionInvocation, settingsFile)).toContain(settingsFile);
    expect(buildExecutionArguments(executionInvocation, settingsFile)).toContain("--strict-mcp-config");
  } finally {
    await rm(settingsDirectory, { recursive: true, force: true });
  }
});

test("limits a scoped execution sandbox to its canonical conflict file", async () => {
  const settingsDirectory = await mkdtemp(path.join(tmpdir(), "claude-runner-test-"));
  const worktree = await mkdtemp(path.join(tmpdir(), "claude-runner-worktree-"));
  const allowed = path.join(worktree, "src", "conflicted.ts");
  await mkdir(path.dirname(allowed), { recursive: true });
  await writeFile(allowed, "unresolved\n");
  const configured = {
    ...executionInvocation, workingDirectory: worktree, executionDirectory: worktree, allowedWritePaths: ["src/conflicted.ts"],
  } satisfies ExecutionInvocation;
  const { settingsFile } = await createExecutionSandboxSettings(configured, settingsDirectory);
  try {
    const settings = JSON.parse(await readFile(settingsFile, "utf8"));
    expect(settings.permissions.allow).toEqual(expect.arrayContaining([`Edit(//${allowed.slice(1)})`]));
    expect(settings.permissions.allow).not.toEqual(expect.arrayContaining([`Edit(//${worktree.slice(1)}/**)`]));
    expect(settings.sandbox.filesystem.allowWrite).toEqual([allowed]);
    expect(settings.sandbox.filesystem.allowWrite).not.toEqual(expect.arrayContaining([worktree]));

    const fileHook = settings.hooks.PreToolUse.find((hook: { matcher: string }) => hook.matcher === "Read|Glob|Grep|Edit|Write");
    const command = fileHook.hooks[0].command as string;
    await expect(runConfiguredHook(command, "Edit", { file_path: allowed }, worktree))
      .resolves.toMatchObject({ code: 0, stdout: "" });
    await expect(runConfiguredHook(command, "Write", { file_path: path.join(worktree, "unrelated.ts") }, worktree))
      .resolves.toMatchObject({ code: 2 });
  } finally {
    await Promise.all([rm(settingsDirectory, { recursive: true, force: true }), rm(worktree, { recursive: true, force: true })]);
  }
});

test("rejects a directory as a scoped execution write target", async () => {
  const settingsDirectory = await mkdtemp(path.join(tmpdir(), "claude-runner-test-"));
  const root = await mkdtemp(path.join(tmpdir(), "claude-runner-worktree-"));
  directories.push(settingsDirectory, root);
  await mkdir(path.join(root, "src"));

  await expect(createExecutionSandboxSettings({
    ...executionInvocation,
    workingDirectory: root,
    executionDirectory: root,
    allowedWritePaths: ["src"],
  }, settingsDirectory)).rejects.toThrow("existing regular file");
});

test("requires Claude versions that support strict sandbox allowlists", () => {
  expect(isClaudeSandboxVersionSupported("2.1.218")).toBe(false);
  expect(isClaudeSandboxVersionSupported("2.1.219")).toBe(true);
  expect(isClaudeSandboxVersionSupported("claude 2.2.0")).toBe(true);
  expect(isClaudeSandboxVersionSupported("unknown")).toBe(false);
});

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
  test("requires a Claude version that enforces strict sandbox allowlists", () => {
    expect(() => assertExecutionSandboxVersion("2.1.218 (Claude Code)")).toThrow("2.1.219");
    expect(() => assertExecutionSandboxVersion("2.1.219 (Claude Code)")).not.toThrow();
    expect(() => assertExecutionSandboxVersion("2.2.0 (Claude Code)")).not.toThrow();
  });

  test("rejects an execution worktree inside the denied host home", async () => {
    const settingsDirectory = await mkdtemp(path.join(tmpdir(), "claude-runner-settings-"));
    directories.push(settingsDirectory);
    await expect(createExecutionSandboxSettings({
      ...invocation,
      workingDirectory: path.join(homedir(), "data", "worktree"),
      executionDirectory: path.join(homedir(), "data", "worktree"),
      logPath: "/log", timeoutMs: 1, onEvent: async () => undefined,
    }, settingsDirectory)).rejects.toThrow("outside the host home");
  });

  test("enables skills and agents with session-local role definitions", async () => {
    const settingsDirectory = await mkdtemp(path.join(tmpdir(), "claude-runner-settings-"));
    directories.push(settingsDirectory);
    const configured = {
      ...invocation,
      pluginDirectories: ["/plugin"],
      guardPath,
      gitMetadataPaths: ["/repo/.git", "/shared/repo.git"],
      sensitiveEnvironmentVariables: ["CLAUDE_CODE_OAUTH_TOKEN", "GITHUB_TOKEN"],
      executionDirectory: "/work",
      logPath: "/log",
      timeoutMs: 1,
      onEvent: async () => undefined,
    } satisfies ExecutionInvocation;
    const { settingsFile } = await createExecutionSandboxSettings(configured, settingsDirectory);
    const args = buildExecutionArguments(configured, settingsFile);
    expect(args).toContain("Read,Glob,Grep,Skill,Agent");
    expect(args).toEqual(expect.arrayContaining(["--setting-sources", ""]));
    expect(args).not.toContain("Read,Glob,Grep,Edit,Write,Bash,Skill,Agent");
    expect(args).toEqual(expect.arrayContaining(["--add-dir", "/skills", "--plugin-dir", "/plugin", "--agents"]));
    const agents = JSON.parse(args[args.indexOf("--agents") + 1]);
    const settings = JSON.parse(await readFile(settingsFile, "utf8"));
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
    expect(JSON.stringify(settings)).toContain(guardPath);
    expect(settings).toMatchObject({
      permissions: {
        allow: expect.arrayContaining(["Edit(//work)", "Edit(//work/**)"]),
        deny: expect.arrayContaining([
          `Read(//${homedir().slice(1)})`, `Read(//${homedir().slice(1)}/**)`,
          `Edit(//${homedir().slice(1)})`, `Edit(//${homedir().slice(1)}/**)`,
          "Read(//repo/.git/**)", "Edit(//repo/.git/**)",
          "Read(//shared/repo.git/**)", "Edit(//shared/repo.git/**)",
        ]),
      },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        credentials: {
          files: expect.arrayContaining([
            { path: "~/.git-credentials", mode: "deny" },
            { path: "~/.netrc", mode: "deny" },
            { path: "~/.npmrc", mode: "deny" },
          ]),
          envVars: [
            { name: "CLAUDE_CODE_OAUTH_TOKEN", mode: "deny" },
            { name: "GITHUB_TOKEN", mode: "deny" },
          ],
        },
        filesystem: {
          denyRead: expect.arrayContaining([homedir(), "/repo/.git", "/shared/repo.git"]),
          allowRead: expect.arrayContaining(["/work", "/skills", "/plugin", "/prompt", guardPath]),
        },
        network: {
          allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true, allowAllUnixSockets: false,
        },
      },
    });

    const fileHook = settings.hooks.PreToolUse.find((hook: { matcher: string }) => hook.matcher === "Read|Glob|Grep|Edit|Write");
    expect(fileHook).toBeDefined();
    const command = fileHook.hooks[0].command as string;
    await expect(runConfiguredHook(command, "Read", { file_path: "/work/package.json" }))
      .resolves.toMatchObject({ code: 0, stdout: "" });
    const denied = await runConfiguredHook(command, "Read", { file_path: path.join(homedir(), "private-notes") });
    expect(denied.code).toBe(2);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe("deny");

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

test("cancels an in-flight planning process when its ownership signal aborts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "claude-planning-abort-"));
  directories.push(root);
  const executable = path.join(root, "claude");
  const started = path.join(root, "started");
  await writeFile(executable, `#!/bin/sh
printf started > ${JSON.stringify(started)}
sleep 0.2
printf '%s\\n' '{"type":"result","subtype":"success","result":"# Plan"}'
`);
  await chmod(executable, 0o755);
  const controller = new AbortController();
  const running = invokePlanningClaude({
    ...invocation,
    claudeExecutable: executable,
    workingDirectory: root,
    signal: controller.signal,
  });
  while (true) {
    try { await access(started); break; } catch { await new Promise((resolve) => setImmediate(resolve)); }
  }
  controller.abort();

  await expect(running).rejects.toMatchObject({ name: "AbortError" });
});

test("invokes planning with only its documented minimal environment", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "claude-planning-env-"));
  directories.push(root);
  const executable = path.join(root, "claude");
  const capture = path.join(root, "environment.json");
  await writeFile(executable, `#!/bin/sh
node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.env))' ${JSON.stringify(capture)}
printf '%s\\n' '{"type":"result","subtype":"success","result":"# Plan","session_id":"session"}'
`);
  await chmod(executable, 0o755);
  const previousGithubToken = process.env.GITHUB_TOKEN;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.GITHUB_TOKEN = "publication-token";
  process.env.DATABASE_URL = "postgres://secret";
  try {
    await invokePlanningClaude({ ...invocation, claudeExecutable: executable, workingDirectory: root });
  } finally {
    if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGithubToken;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
  const environment = JSON.parse(await readFile(capture, "utf8"));
  expect(environment).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "token", AGENT_CONTROL_DISABLE: "1" });
  expect(environment.GITHUB_TOKEN).toBeUndefined();
  expect(environment.DATABASE_URL).toBeUndefined();
});

test("invokes execution with a materialized guard outside the worktree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "claude-execution-"));
  directories.push(root);
  const bin = path.join(root, "bin");
  const capture = path.join(root, "capture.json");
  await mkdir(bin);
  const executable = path.join(bin, "claude");
  await mkdir(path.join(root, ".git"));
  await writeFile(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\n' '2.1.220 (Claude Code)'; exit 0; fi
test ! -e ${JSON.stringify(path.join(root, ".git"))} || exit 3
for arg in "$@"; do
  if [ "$previous" = "--settings" ]; then settings="$arg"; fi
  previous="$arg"
done
node -e 'const fs=require("node:fs"); fs.writeFileSync(process.argv[1], JSON.stringify({ settings: JSON.parse(fs.readFileSync(process.argv[2], "utf8")), settingsFile: process.argv[2], configDir: process.env.CLAUDE_CONFIG_DIR, scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, autoMemory: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, publicationCredential: process.env.GITHUB_TOKEN }))' ${JSON.stringify(capture)} "$settings"
`);
  await chmod(executable, 0o755);
  const previousGithubToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "publication-token";
  try {
    await expect(invokeExecutionClaude({
      ...invocation,
      claudeExecutable: executable,
      workingDirectory: root,
      executionDirectory: root,
      gitMetadataPaths: [path.join(root, ".git")],
      logPath: path.join(root, "run.log"),
      timeoutMs: 1_000,
      onEvent: async () => undefined,
    })).resolves.toMatchObject({ exitCode: 0 });
  } finally {
    if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGithubToken;
  }
  const captured = JSON.parse(await (await import("node:fs/promises")).readFile(capture, "utf8"));
  const settings = captured.settings;
  const command = settings.hooks.PreToolUse[0].hooks[0].command;
  expect(command).toContain("/tmp/dcc-claude-guard-");
  expect(command).not.toContain(root);
  expect(captured.scrub).toBe("1");
  expect(captured.autoMemory).toBe("1");
  expect(captured.publicationCredential).toBeUndefined();
  await expect(access(captured.settingsFile)).rejects.toThrow();
  await expect(access(captured.configDir)).rejects.toThrow();
  await expect((await import("node:fs/promises")).access(path.join(root, ".git"))).resolves.toBeUndefined();
  expect(settings.sandbox).toMatchObject({
    enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
  });
});

test("runs scoped execution in a read-only worktree with only conflict files rebound writable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "claude-scoped-bwrap-"));
  directories.push(root);
  const worktree = path.join(root, "worktree");
  const allowed = path.join(worktree, "src", "conflicted.ts");
  const unrelated = path.join(worktree, "unrelated.ts");
  const bin = path.join(root, "bin");
  const fakeBwrap = path.join(bin, "bwrap");
  const fakeClaude = path.join(bin, "claude");
  const capture = path.join(root, "bwrap.json");
  await mkdir(path.dirname(allowed), { recursive: true });
  await Promise.all([
    mkdir(path.join(worktree, ".git")), mkdir(bin), writeFile(path.join(root, "prompt.md"), "resolve\n"), writeFile(allowed, "unresolved\n"), writeFile(unrelated, "unchanged\n"),
  ]);
  await writeFile(fakeClaude, `#!/bin/sh
if [ "$1" = "--version" ]; then test "$DCC_FAKE_BWRAP" = 1 || exit 97; printf '%s\\n' '2.1.220 (Claude Code)'; exit 0; fi
printf resolved > ${JSON.stringify(allowed)}
if printf escaped > ${JSON.stringify(unrelated)}; then exit 98; fi
printf '%s\\n' '{"type":"result","subtype":"success","result":"resolved"}'
`);
  await writeFile(fakeBwrap, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const pairs = (flag) => args.flatMap((value, index) => value === flag ? [[args[index + 1], args[index + 2]]] : []);
const ro = pairs("--ro-bind");
const rw = pairs("--bind");
const worktree = ${JSON.stringify(worktree)};
const allowed = ${JSON.stringify(allowed)};
const unrelated = ${JSON.stringify(unrelated)};
if (!ro.some(([source, target]) => source === worktree && target === worktree)) process.exit(91);
if (JSON.stringify(rw) !== JSON.stringify([[allowed, allowed]])) process.exit(92);
if (args.includes("--unshare-net")) process.exit(93);
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ ro, rw, command: args[args.indexOf("--") + 1] }) + "\\n");
const mappings = new Map([...ro, ...rw].map(([source, target]) => [target, source]));
const separator = args.indexOf("--");
const command = mappings.get(args[separator + 1]) ?? args[separator + 1];
const cwd = args[args.indexOf("--chdir") + 1];
let exitCode = 1;
try {
  fs.chmodSync(worktree, 0o555);
  fs.chmodSync(unrelated, 0o444);
  const result = spawnSync(command, args.slice(separator + 2), { cwd, env: { ...process.env, PATH: ${JSON.stringify(process.env.PATH)}, DCC_FAKE_BWRAP: "1" }, stdio: "inherit" });
  exitCode = result.status ?? 1;
} finally {
  fs.chmodSync(worktree, 0o755);
  fs.chmodSync(unrelated, 0o644);
}
process.exit(exitCode);
`);
  await Promise.all([chmod(fakeClaude, 0o755), chmod(fakeBwrap, 0o755)]);
  const previousBwrap = process.env.DCC_CLAUDE_BWRAP_PATH;
  process.env.DCC_CLAUDE_BWRAP_PATH = fakeBwrap;
  try {
    await expect(invokeExecutionClaude({
      ...invocation,
      claudeExecutable: fakeClaude,
      workingDirectory: worktree,
      executionDirectory: worktree,
      promptFile: path.join(root, "prompt.md"),
      gitMetadataPaths: [path.join(worktree, ".git")],
      logPath: path.join(root, "run.log"),
      timeoutMs: 1_000,
      allowedWritePaths: ["src/conflicted.ts"],
      onEvent: async () => undefined,
    })).resolves.toMatchObject({ exitCode: 0 });
  } finally {
    if (previousBwrap === undefined) delete process.env.DCC_CLAUDE_BWRAP_PATH;
    else process.env.DCC_CLAUDE_BWRAP_PATH = previousBwrap;
  }
  expect(await readFile(allowed, "utf8")).toBe("resolved");
  expect(await readFile(unrelated, "utf8")).toBe("unchanged\n");
  const launches = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(launches).toHaveLength(2);
  expect(launches).toEqual(expect.arrayContaining([expect.objectContaining({ rw: [[allowed, allowed]] })]));
});

test("observes a rejected execution event write immediately and still rejects the invocation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "claude-event-rejection-"));
  directories.push(root);
  const executable = path.join(root, "claude");
  await mkdir(path.join(root, ".git"));
  await writeFile(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' '2.1.220 (Claude Code)'; exit 0; fi
printf '%s\\n' '{"type":"assistant","message":"event"}'
sleep 0.2
`);
  await chmod(executable, 0o755);
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  try {
    await expect(invokeExecutionClaude({
      ...invocation,
      claudeExecutable: executable,
      workingDirectory: root,
      executionDirectory: root,
      gitMetadataPaths: [path.join(root, ".git")],
      logPath: path.join(root, "run.log"),
      timeoutMs: 1_000,
      onEvent: async () => { throw new Error("event write failed"); },
    })).rejects.toThrow("event write failed");
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("keeps shell execution behind guarded subagents", () => {
  const args = buildExecutionArguments(executionInvocation, "/settings");

  expect(args).toContain("dontAsk");
  expect(args).toContain("Read,Glob,Grep,Skill,Agent");
  expect(args).not.toContain("Bash,Agent,Skill");
  expect(args).toContain("--strict-mcp-config");
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
