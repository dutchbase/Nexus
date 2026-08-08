import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("create-admin", () => {
  async function invalidPassword(input: string | Buffer) {
    const child = spawn("pnpm", ["exec", "tsx", "scripts/create-admin.ts", "--username", "admin", "--password-stdin", "--non-interactive"], {
      cwd: root,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.end(input);
    const [code] = await once(child, "close");
    expect(code).not.toBe(0);
    expect(stderr).toContain("Password must be 1-4096 UTF-8 bytes without NUL, CR, or LF");
  }

  it("validates empty and forbidden stdin passwords before looking up the user", async () => {
    await invalidPassword("");
    await invalidPassword(Buffer.from("bad\0password"));
    await invalidPassword("bad\npassword");
  }, 15_000);

  it("rejects an oversized stdin password before EOF", async () => {
    const child = spawn("pnpm", ["exec", "tsx", "scripts/create-admin.ts", "--username", "admin", "--password-stdin", "--non-interactive"], {
      cwd: root,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.write(Buffer.alloc(4097, "a"));

    const result = await Promise.race([
      once(child, "close").then(([code]) => ({ code })),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("reader waited for EOF")), 3_000)),
    ]).finally(() => child.kill());

    expect(result.code).not.toBe(0);
    expect(stderr).toContain("Password must be 1-4096 UTF-8 bytes without NUL, CR, or LF");
  });
});
