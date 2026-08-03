import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const binary = join(tmpdir(), `dcc-argon2-helper-${process.pid}`);
const source = join(dirname(fileURLToPath(import.meta.url)), "..", "native", "argon2-helper.c");
execFileSync("gcc", [source, "-O2", "-Wl,-l:libargon2.so.1", "-o", binary], { stdio: "ignore" });

const passwordError = "Password must be 1-4096 UTF-8 bytes without NUL, CR, or LF";

function validatePassword(password: string) {
  const bytes = Buffer.byteLength(password, "utf8");
  if (!bytes || bytes > 4096 || /[\0\r\n]/.test(password)) throw new Error(passwordError);
}

function execute(mode: "hash" | "verify", input: string, encoded?: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, encoded ? [mode, encoded] : [mode], { stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(output) : reject(new Error(`Argon2 ${mode} failed`)));
    child.stdin.end(input);
  });
}

export async function hashPassword(password: string) {
  validatePassword(password);
  return (await execute("hash", password)).trim();
}

export async function verifyPassword(encoded: string, password: string) {
  try {
    validatePassword(password);
    await execute("verify", password, encoded);
    return true;
  } catch {
    return false;
  }
}
