import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeSkillBundle } from "./index.ts";

let root = "";

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("skill bundles", () => {
  it("creates an empty bundle root", async () => {
    root = await mkdtemp(path.join(tmpdir(), "dcc-skill-bundle-"));
    const bundle = await materializeSkillBundle("00000000-0000-0000-0000-000000000000", [], root);
    await expect(access(bundle)).resolves.toBeUndefined();
  });
});
