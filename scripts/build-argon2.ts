import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "packages", "database", "native", "argon2-helper.c");
const outDir = join(root, "packages", "database", "native", "build");
const binary = join(outDir, "argon2-helper");

mkdirSync(outDir, { recursive: true });
try {
  execFileSync("gcc", [source, "-O2", "-Wl,-l:libargon2.so.1", "-o", binary], { stdio: "inherit" });
} catch (error) {
  console.error(
    "Failed to build the Argon2 helper. Install a C toolchain and libargon2 (Debian/Ubuntu: sudo apt-get install build-essential libargon2-dev), then re-run `pnpm build:argon2`, or set DCC_ARGON2_HELPER_PATH to a prebuilt binary.",
  );
  process.exit(1);
}
console.log(`Built Argon2 helper at ${binary}`);
