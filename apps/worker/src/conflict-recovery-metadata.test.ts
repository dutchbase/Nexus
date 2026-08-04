import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("records conflict job and resolution identifiers with its authority profile", async () => {
  const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
  const conflict = worker.slice(worker.indexOf("async function runPrConflictResolution"));

  expect(conflict).toContain("job_id: job.id");
  expect(conflict).toContain("pr_conflict_resolution_id: payload.pr_conflict_resolution_id");
  expect(conflict).toContain('authority_profile: "conflict-resolution"');
});
