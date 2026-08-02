import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { allowsAgent, allowsBashCommand } from "./bash-guard.mjs";
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
