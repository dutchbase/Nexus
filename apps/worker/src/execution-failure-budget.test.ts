import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

const worker = () => readFile(new URL("./worker.ts", import.meta.url), "utf8");
const executionSection = (source: string) =>
  source.slice(source.indexOf("async function runExecution"), source.indexOf("async function publishExecutionAttempt"));

test("both execution engines get the 45-minute default timeout budget", async () => {
  const execution = executionSection(await worker());
  const defaults = execution.match(/execution_timeout_ms \?\? \d+ \* 60 \* 1000/g) ?? [];

  expect(defaults).toEqual(["execution_timeout_ms ?? 45 * 60 * 1000", "execution_timeout_ms ?? 45 * 60 * 1000"]);
});

test("planning keeps its own 30-minute budget and execution keeps its 50-turn ceiling", async () => {
  const source = await worker();

  expect(source).toContain("planning_timeout_ms ?? 30 * 60 * 1000");
  expect(source).toContain("execution_max_turns ?? 50");
});

test("a failed execution stores the raw stdout for post-mortem, like the planning path", async () => {
  const execution = executionSection(await worker());

  expect(execution).toContain('const rawStdoutOnFailure = typeof (error as any)?.stdout === "string" ? (error as any).stdout : undefined;');
  expect(execution).toContain("metadata_json=metadata_json || $6::jsonb");
  expect(execution).toContain("JSON.stringify(rawStdoutOnFailure ? { raw_stdout_on_failure: rawStdoutOnFailure } : {})");
});
