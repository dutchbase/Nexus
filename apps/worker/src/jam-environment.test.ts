import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const root = new URL("../../../", import.meta.url);

test("keeps the Jam credential in the worker environment", () => {
  const token = "DCC_JAM_TOKEN";
  const ecosystem = readFileSync(new URL("ecosystem.config.cjs", root), "utf8");
  const development = readFileSync(new URL("scripts/dev.ts", root), "utf8");
  const example = readFileSync(new URL(".env.example", root), "utf8");
  expect(ecosystem).toContain(`-u ${token}`);
  expect(development).toContain(`${token}: undefined`);
  expect(example.indexOf(token)).toBeGreaterThan(example.indexOf("Worker-only credentials"));
});
