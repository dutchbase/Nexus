import { describe, expect, it } from "vitest";
import { ticketQuickActions } from "./tickets.ts";

const byKey = (status: string) =>
  Object.fromEntries(ticketQuickActions({ status }).map((action) => [action.key, action]));

describe("ticketQuickActions", () => {
  it("always returns the four actions in a stable order with a glyph and a label", () => {
    const actions = ticketQuickActions({ status: "Submitted" });
    expect(actions.map((action) => action.key)).toEqual(["acknowledge", "start-planning", "execute", "delete"]);
    for (const action of actions) {
      expect(action.glyph).not.toBe("");
      expect(action.label).not.toBe("");
    }
  });

  it("enables acknowledge only for a Submitted ticket", () => {
    expect(byKey("Submitted").acknowledge.enabled).toBe(true);
    expect(byKey("Triage").acknowledge.enabled).toBe(false);
    expect(byKey("Triage").acknowledge.disabledReason).toContain("Submitted");
  });

  it("enables planning from Triage, Needs Information and Planning Failed", () => {
    for (const status of ["Triage", "Needs Information", "Planning Failed"]) {
      expect(byKey(status)["start-planning"].enabled).toBe(true);
    }
    for (const status of ["Submitted", "Planning", "Plan Approved"]) {
      expect(byKey(status)["start-planning"].enabled).toBe(false);
    }
  });

  it("enables execution only from Plan Approved and Execution Failed", () => {
    expect(byKey("Plan Approved").execute.enabled).toBe(true);
    expect(byKey("Execution Failed").execute.enabled).toBe(true);
    // The approval gate also accepts "Execution Queued", but the execute route
    // rejects it with "an execution is already active" — do not offer it.
    expect(byKey("Execution Queued").execute.enabled).toBe(false);
    expect(byKey("Merged").execute.enabled).toBe(false);
  });

  it("enables delete only for tickets that never entered the planning pipeline", () => {
    for (const status of ["Submitted", "Triage", "Needs Information", "Rejected", "Cancelled"]) {
      expect(byKey(status).delete.enabled).toBe(true);
    }
    for (const status of ["Planning", "Plan Approved", "Executing", "Merged", "Completed", "Archived"]) {
      expect(byKey(status).delete.enabled).toBe(false);
    }
  });

  it("gives every disabled action a reason to show in its tooltip", () => {
    for (const action of ticketQuickActions({ status: "Merged" })) {
      if (!action.enabled) expect(action.disabledReason.length).toBeGreaterThan(0);
    }
  });
});
