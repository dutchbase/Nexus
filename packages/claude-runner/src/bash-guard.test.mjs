import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { allowsAgent, allowsBashCommand, allowsFileTool } from "./bash-guard.mjs";
import { materializeBashGuard } from "./index.ts";

const guard = fileURLToPath(new URL("./bash-guard.mjs", import.meta.url));
const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

function runHook(toolName, toolInput) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [guard]);
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify({ tool_name: toolName, tool_input: toolInput }));
  });
}

describe("execution Bash guard", () => {
  test("permits only direct status and test commands", async () => {
    for (const command of ["git status --short", "git diff --check", "git log -1", "pnpm exec vitest run packages/domain/src/prompts.test.ts", "pnpm exec tsc --noEmit"]) {
      expect(allowsBashCommand(command)).toBe(true);
      await expect(runHook("Bash", { command })).resolves.toMatchObject({ code: 0, stdout: "" });
    }
  });

  test("denies substitutions, chains, redirects, alternate executables, providers, and package scripts", async () => {
    const commands = [
      "git status $(git push)", "git status `git push`", "git status && git push", "git status ; git push", "git status | git push", "git status > output",
      "/usr/bin/git push", "git --git-dir=/repo/.git push", "gh api repos/org/repo/pulls", "curl https://api.github.com", "alias git='git push'", "function git() { git push; }",
      "pnpm test", "pnpm exec vitest run && git push",
    ];
    for (const command of commands) {
      expect(allowsBashCommand(command)).toBe(false);
      const result = await runHook("Bash", { command });
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    }
  });

  test("permits only named DCC roles for Agent", async () => {
    for (const subagent_type of ["dcc-mechanical", "dcc-implementer", "dcc-repair", "dcc-reviewer"]) {
      expect(allowsAgent({ subagent_type })).toBe(true);
      await expect(runHook("Agent", { subagent_type })).resolves.toMatchObject({ code: 0, stdout: "" });
    }
    for (const subagent_type of ["general-purpose", "Bash", "dcc-publisher", undefined]) {
      expect(allowsAgent({ subagent_type })).toBe(false);
      const result = await runHook("Agent", { subagent_type });
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    }
  });

  test("confines built-in reads and writes to their explicit roots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-file-guard-"));
    directories.push(root);
    const worktree = path.join(root, "worktree");
    const bundle = path.join(root, "bundle");
    const outside = path.join(root, "private-notes");
    await Promise.all([mkdir(worktree), mkdir(bundle)]);
    await writeFile(outside, "host secret\n");
    await symlink(outside, path.join(worktree, "escaped-link"));
    const policy = { readRoots: [worktree, bundle], writeRoot: worktree };

    for (const input of [
      { tool_name: "Read", tool_input: { file_path: path.join(worktree, "README.md") }, cwd: worktree },
      { tool_name: "Glob", tool_input: { pattern: "**/*.ts" }, cwd: worktree },
      { tool_name: "Grep", tool_input: { pattern: "TODO", path: bundle }, cwd: worktree },
      { tool_name: "Edit", tool_input: { file_path: path.join(worktree, "src.ts") }, cwd: worktree },
      { tool_name: "Write", tool_input: { file_path: path.join(worktree, "new.ts") }, cwd: worktree },
    ]) expect(allowsFileTool(input, policy)).toBe(true);

    for (const input of [
      { tool_name: "Read", tool_input: { file_path: outside }, cwd: worktree },
      { tool_name: "Read", tool_input: { file_path: path.join(worktree, "escaped-link") }, cwd: worktree },
      { tool_name: "Glob", tool_input: { pattern: "*", path: homedir() }, cwd: worktree },
      { tool_name: "Grep", tool_input: { pattern: "secret", path: root }, cwd: worktree },
      { tool_name: "Edit", tool_input: { file_path: path.join(bundle, "SKILL.md") }, cwd: worktree },
      { tool_name: "Write", tool_input: { file_path: outside }, cwd: worktree },
    ]) expect(allowsFileTool(input, policy)).toBe(false);
  });

  test("uses a read-only materialized guard after the checkout copy changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-guard-source-"));
    directories.push(root);
    const source = path.join(root, "worktree", "bash-guard.mjs");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, await readFile(guard, "utf8"));
    const materialized = await materializeBashGuard(source);
    try {
      await writeFile(source, "process.exit(0)\n");
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [materialized.path]);
        let stdout = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout }));
        child.stdin.end(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" } }));
      });
      expect(result).toMatchObject({ code: 2 });
      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
      expect((await stat(materialized.path)).mode & 0o222).toBe(0);
      expect(materialized.path.startsWith(path.dirname(source))).toBe(false);
    } finally {
      await materialized.cleanup();
    }
  });
});
