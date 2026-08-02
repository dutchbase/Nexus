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
  expect(source).toContain("skillsForPhase(approvedSnapshot.skills_json, phase)");
  expect(source).toContain("skillSnapshotId: approvedSnapshot.id");
  expect(source).toContain("materializeSkillBundle(runId, phaseSkills");
});

test("requires a normal execution to invoke Agent before worker validation and publishing", async () => {
  const source = await worker();

  expect(source).toContain("usedAgent ||= isAgentToolEvent(eventType, event)");
  expect(source).toContain('if (!repairing && !usedAgent) throw new Error("execution did not invoke Agent tool")');
});

test("wraps legacy 17-section plans as synthetic Task 1 for execution", async () => {
  const source = await worker();

  expect(source).toContain("function taskBriefPlan(approvedPlan: string)");
  expect(source).toContain("## Task 1: Implement the approved legacy plan");
  expect(source).toContain("exactApprovedPlan: taskBriefPlan(approvedPlan)");
});
