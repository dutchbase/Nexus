import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

const worker = () => readFile(new URL("./worker.ts", import.meta.url), "utf8");

test("commits a generated plan and its completed run in the same transaction", async () => {
  const source = await worker();
  const store = source.slice(source.indexOf("async function storePlan"), source.indexOf("async function storeRevisedPlan"));

  expect(store).toContain("exitCode: number; raw: unknown");
  expect(store).toContain("UPDATE agent_runs SET status='completed',claude_session_id=$2,finished_at=now(),exit_code=$3");
  expect(store).toContain("client.query(");
});

test("records planning failure and Planning Failed in one transaction", async () => {
  const source = await worker();
  const planning = source.slice(source.indexOf("async function runPlanning"), source.indexOf("async function runExecution"));
  const failure = planning.slice(planning.indexOf("} catch (error)"));

  expect(failure.indexOf("await inTransaction(async (client) =>")).toBeLessThan(failure.indexOf("UPDATE agent_runs SET status='failed'"));
});

test("handles setup failures after Planning begins through the same finalizer", async () => {
  const source = await worker();
  const planning = source.slice(source.indexOf("async function runPlanning"), source.indexOf("async function runExecution"));

  expect(planning.indexOf("try {")).toBeLessThan(planning.indexOf("const copied = await snapshotSkillSet"));
});

test("uses the 30-minute planning timeout unless the project overrides it", async () => {
  const source = await worker();
  const planning = source.slice(source.indexOf("async function runPlanning"), source.indexOf("async function runExecution"));

  expect(planning).toContain("timeoutMs: Number(input.project.config_json?.planning_timeout_ms ?? 30 * 60 * 1000)");
});
