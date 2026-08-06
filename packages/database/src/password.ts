import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const defaultBinary = join(dirname(fileURLToPath(import.meta.url)), "..", "native", "build", "argon2-helper");

function ensureBinary(): string {
  const binary = process.env.DCC_ARGON2_HELPER_PATH ?? defaultBinary;
  if (!existsSync(binary)) {
    throw new Error(
      `Argon2 helper binary not found at ${binary}. Run \`pnpm build:argon2\` (requires gcc and libargon2) or set DCC_ARGON2_HELPER_PATH to a prebuilt binary.`,
    );
  }
  return binary;
}

const passwordError = "Password must be 1-4096 UTF-8 bytes without NUL, CR, or LF";

export function validatePassword(password: string) {
  const bytes = Buffer.byteLength(password, "utf8");
  if (!bytes || bytes > 4096 || /[\0\r\n]/.test(password)) throw new Error(passwordError);
}

function execute(mode: "hash" | "verify", input: string, encoded?: string) {
  const binary = ensureBinary();
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
