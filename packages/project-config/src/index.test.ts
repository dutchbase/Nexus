import { chmod, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeAgentStartPath, validateAgentStartPath } from "./index.ts";

describe("planning agent start path", () => {
  it("normalizes blank input to no configured path", async () => {
    expect(normalizeAgentStartPath("  ")).toBeNull();
    expect(normalizeAgentStartPath("/workspace/planning")).toBe("/workspace/planning");
    await expect(validateAgentStartPath("   ")).resolves.toEqual([]);
  });

  it("accepts an absolute readable directory and rejects invalid configured paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "dcc-start-path-"));
    const directory = join(root, "planning");
    await mkdir(directory);

    await expect(validateAgentStartPath(directory)).resolves.toEqual([]);
    await expect(validateAgentStartPath("relative/path")).resolves.toEqual(["planning agent start path must be absolute"]);
    await expect(validateAgentStartPath(join(root, "missing"))).resolves.toEqual(["planning agent start path is not a readable and searchable directory"]);
  });

  it("rejects a non-string configured path", async () => {
    await expect(validateAgentStartPath(123 as never)).resolves.toEqual(["planning agent start path must be a string"]);
  });

  it.skipIf(process.platform === "win32")("rejects a directory that cannot be searched", async () => {
    const root = await mkdtemp(join(tmpdir(), "dcc-start-path-"));
    const directory = join(root, "not-searchable");
    await mkdir(directory);
    await chmod(directory, 0o600);

    await expect(validateAgentStartPath(directory)).resolves.toEqual(["planning agent start path is not a readable and searchable directory"]);
  });
});
