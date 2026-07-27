import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const binary = join(tmpdir(), `dcc-argon2-helper-${process.pid}`);
const source = join(dirname(fileURLToPath(import.meta.url)), "..", "native", "argon2-helper.c");
execFileSync("gcc", [source, "-O2", "-Wl,-l:libargon2.so.1", "-o", binary], { stdio: "ignore" });

function execute(mode: "hash" | "verify", input: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, [mode], { stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(output) : reject(new Error(`Argon2 ${mode} failed`)));
    child.stdin.end(input);
  });
}

export async function hashPassword(password: string) {
  return (await execute("hash", `${password}\n`)).trim();
}

export async function verifyPassword(encoded: string, password: string) {
  try {
    await execute("verify", `${password}\n${encoded}\n`);
    return true;
  } catch {
    return false;
  }
}
