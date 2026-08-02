import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeSkillBundle } from "./index.ts";

let root = "";

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("materializeSkillBundle cleanup", () => {
  it("removes the temporary root when materialization fails", async () => {
    root = await mkdtemp(join(tmpdir(), "dcc-skill-bundle-failure-"));

    await expect(materializeSkillBundle([{
      skill_id: "88888888-8888-4888-8888-888888888888",
      slug: "INVALID",
      version: null,
      filesystem_path: "unused",
      resolution_sources: ["global_mandatory"],
      phase: "planning",
      files: [],
      content_hash: "unused",
    }], root)).rejects.toThrow("invalid skill slug");

    await expect(readdir(root)).resolves.toEqual([]);
  });
});
