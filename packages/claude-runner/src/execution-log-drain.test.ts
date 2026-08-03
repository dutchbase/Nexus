import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("drains stdout and stderr log writes before an execution invocation settles", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");

  expect(source).not.toContain("void appendFile(input.logPath, text)");
  expect(source).toContain("let logWrites = Promise.resolve()");
  expect(source).toContain("Promise.all([eventWrites, logWrites])");
});
