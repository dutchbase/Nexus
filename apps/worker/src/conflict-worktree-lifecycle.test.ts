import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("removes temporary conflict-resolution worktrees after either successful path", async () => {
  const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");

  expect(worker.match(/removeManagedWorktree/g)).toHaveLength(3);
  expect(worker).toContain("working_directory=NULL");
});
