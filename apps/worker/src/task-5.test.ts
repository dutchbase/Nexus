import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

const worker = () => readFile(new URL("./worker.ts", import.meta.url), "utf8");

test("freezes the planning, execution, and repair skill union when planning starts", async () => {
  const source = await worker();

  expect(source).toContain('snapshotSkillSet(input.skillUnion, ["planning", "execution", "repair"])');
  expect(source).toContain('skillsForPhase(copied.skills, "planning")');
});

test("runs each execution phase from its approved snapshot and materializes only that phase", async () => {
  const source = await worker();

  expect(source).toContain("WHERE id=$1 AND ticket_id=$2");
  expect(source).toContain("ticket.approved_skill_snapshot_id");
  expect(source).toContain("approvedPhaseSkills(approvedSnapshot, ticket.id, phase)");
  expect(source).toContain("skillSnapshotId: approvedSnapshot.id");
  expect(source).toContain("materializeSkillBundle(runId, phaseSkills");
});

test("requires a normal execution to invoke Agent before worker validation and publishing", async () => {
  const source = await worker();
  const execution = source.slice(source.indexOf("async function runExecution"), source.indexOf("async function publishExecutionAttempt"));

  expect(source).toContain("usedAgent ||= isAgentToolEvent(eventType, event)");
  const gate = execution.indexOf("assertExecutionPublicationGate(repairing, usedAgent)");
  expect(gate).toBeGreaterThan(0);
  expect(execution.lastIndexOf("await finalizeAiUsage(runId, result)", gate)).toBeGreaterThan(0);
});

test("materializes the immutable approved plan for execution", async () => {
  const source = await worker();

  expect(source).toContain("materializeExecutionPlan(gate.planVersion.content_markdown)");
});
