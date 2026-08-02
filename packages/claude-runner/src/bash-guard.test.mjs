import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { allowsBashCommand } from "./bash-guard.mjs";

const guard = fileURLToPath(new URL("./bash-guard.mjs", import.meta.url));

function runHook(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [guard]);
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify({ tool_input: { command } }));
  });
}

describe("execution Bash guard", () => {
  test("permits only direct status and test commands", async () => {
    for (const command of ["git status --short", "git diff --check", "git log -1", "pnpm exec vitest run packages/domain/src/prompts.test.ts", "pnpm exec tsc --noEmit"]) {
      expect(allowsBashCommand(command)).toBe(true);
      await expect(runHook(command)).resolves.toMatchObject({ code: 0, stdout: "" });
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
      const result = await runHook(command);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    }
  });
});
