// SEC-14 [HARD-FAIL]: every planning.generate / planning.revise job's
// mock-claude invocation must be logged with --permission-mode dontAsk and a
// --tools value drawn only from the read-oriented set (Read, Glob, Grep,
// Bash) — never Edit or Write. PRD §18.2/§18.3.
//
// mock-claude (harness/mock-claude/claude) does NOT put `tools` inside its
// logged `parsed` object (only model/effort/permission_mode/output_format/
// session_id/max_turns are — see harness/mock-claude/claude's `logData`).
// The --tools value only shows up in the raw `argv` array, so this file
// reads it from there (falling back to `parsed.tools` in case a future
// mock-claude revision adds it).
//
// We exercise TWO distinct planning-phase jobs (a fresh planning.generate
// and a planning.revise) specifically to catch a hardcoded one-off pass —
// see SEC-14's description.
//
// Correlating "which log line is mine" uses agent_runs.claude_session_id
// (assumed to equal the --session-id argv value mock-claude echoes back as
// parsed.session_id) rather than log-file ordering, so this test doesn't
// depend on scenario-routing plumbing working — see tests/api/_pipeline.ts
// for the documented assumptions that plumbing relies on.

import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { login, readMockClaudeLog, writeMockClaudeScenario, DEFAULT_PLAN_MARKDOWN, queryOne, api } from "../helpers";
import {
  submitTicket,
  moveToTriageAndApprovePlanning,
  routeScenarioToNextJob,
  waitForAgentRun,
  waitForTicketStatus,
} from "./_pipeline";

const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "Bash"]);

function toolsValueFor(entry: any): string | null {
  if (typeof entry?.parsed?.tools === "string") return entry.parsed.tools;
  const argv: string[] = entry?.argv ?? [];
  const idx = argv.indexOf("--tools");
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : null;
}

function assertReadOnlyInvocation(entry: any, label: string) {
  expect(entry, `${label}: no mock-claude log entry found`).toBeTruthy();
  expect(entry.parsed?.permission_mode, `${label}: --permission-mode`).toBe("dontAsk");
  const tools = toolsValueFor(entry);
  expect(tools, `${label}: --tools value`).toBeTruthy();
  expect(tools).not.toContain("Edit");
  expect(tools).not.toContain("Write");
  const list = (tools as string).split(",").map((t) => t.trim()).filter(Boolean);
  expect(list.length).toBeGreaterThan(0);
  for (const tool of list) {
    expect(READ_ONLY_TOOLS.has(tool), `${label}: unexpected tool "${tool}" in --tools="${tools}"`).toBe(true);
  }
}

describe("planning sessions are read-only", () => {
  it("planning sessions are read-only", async () => {
    const session = await login();
    const marker = randomUUID();
    const ticket = await submitTicket({
      formSlug: "ui-ux-feedback",
      title: `SEC-14 planning permissions ${marker}`,
      description: `SEC-14 planning permissions probe ${marker}`,
    });

    const scenarioPath = writeMockClaudeScenario({ mode: "plan_valid", plan_markdown: DEFAULT_PLAN_MARKDOWN });
    const sinceIso = new Date().toISOString();
    const routing = routeScenarioToNextJob("planning.generate", sinceIso, scenarioPath);
    await moveToTriageAndApprovePlanning(session, ticket.id);
    await routing;

    const initialRun = await waitForAgentRun(ticket.id, "planning%");
    const log1 = readMockClaudeLog();
    const entry1 = log1.find((e) => e.parsed?.session_id === initialRun.claude_session_id);
    assertReadOnlyInvocation(entry1, "planning.generate");

    // Need the plan to have actually landed for revision to be requestable.
    await waitForTicketStatus(ticket.id, ["Plan Ready for Review"], 30000);

    const plan = await queryOne("select id from plans where ticket_id = $1", [ticket.id]);
    expect(plan, "plans row for ticket").toBeTruthy();

    const revisionScenarioPath = writeMockClaudeScenario({ mode: "plan_valid", plan_markdown: DEFAULT_PLAN_MARKDOWN });
    const sinceIso2 = new Date().toISOString();
    const routing2 = routeScenarioToNextJob("planning.revise", sinceIso2, revisionScenarioPath);
    const revisionRes = await api(session, "POST", `/api/admin/plans/${plan.id}/request-revision`, {
      feedback: "Please add more detail to section 7.",
    });
    expect(revisionRes.status, `request-revision: ${await revisionRes.text().catch(() => "")}`).toBeLessThan(300);
    await routing2;

    const revisionRun = await waitForAgentRun(ticket.id, "%revis%");
    expect(revisionRun.id).not.toBe(initialRun.id);
    const log2 = readMockClaudeLog();
    const entry2 = log2.find((e) => e.parsed?.session_id === revisionRun.claude_session_id);
    assertReadOnlyInvocation(entry2, "planning.revise");
  }, 90000);
});
