import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("registers successful conflict worktrees as owned artifacts without deleting them", async () => {
  const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");

  expect(worker).not.toContain("removeManagedWorktree");
  expect(worker).toContain("working_directory=NULL");
  expect(worker).toContain("'conflict_worktree'");
  expect(worker).toContain("INSERT INTO artifacts");
});
