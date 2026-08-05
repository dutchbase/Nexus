import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("dashboard reports worker health without reading worker credentials", async () => {
  const source = await readFile(new URL("./pages/dashboard.ts", import.meta.url), "utf8");
  expect(source).toContain("FROM workers");
  expect(source).not.toContain("process.env.");
});
