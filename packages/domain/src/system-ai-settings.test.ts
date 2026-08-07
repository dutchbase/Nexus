import { describe, expect, it } from "vitest";
import { getSystemAiSettings, resolvedAiFor } from "./planning-inputs.ts";

const systemRow = {
  default_model: "sonnet", default_reasoning_level: "high",
  planning_model: null, planning_reasoning_level: null,
  execution_model: null, execution_reasoning_level: null,
  repair_model: null, repair_reasoning_level: null,
};

const fixtureClient = (row: typeof systemRow) => ({
  async query(sql: string) {
    if (sql.includes("FROM system_ai_settings")) return { rows: [row] };
    throw new Error(`unexpected query: ${sql}`);
  },
});

describe("getSystemAiSettings", () => {
  it("shapes the singleton row into an AiConfiguration", async () => {
    const config = await getSystemAiSettings(fixtureClient(systemRow));
    expect(config).toEqual({
      default: { model: "sonnet", reasoning_level: "high" },
      planning: { model: null, reasoning_level: null },
      execution: { model: null, reasoning_level: null },
      repair: { model: null, reasoning_level: null },
    });
  });
});

const project = { config_json: { ai: {} } };
const ticketWithoutOverrides = { default_model: null, default_reasoning_level: null, planning_model: null, planning_reasoning_level: null, execution_model: null, execution_reasoning_level: null, repair_model: null, repair_reasoning_level: null };

describe("resolvedAiFor with a system-level override", () => {
  it("falls through to the system default when nothing else overrides it", () => {
    const systemAi = { default: { model: "sonnet", reasoning_level: "high" }, planning: { model: null, reasoning_level: null }, execution: { model: null, reasoning_level: null }, repair: { model: null, reasoning_level: null } };
    expect(resolvedAiFor(ticketWithoutOverrides, project, "planning", systemAi))
      .toEqual({ model: "sonnet", reasoning_level: "high" });
  });

  it("uses a system phase-specific override ahead of the system default", () => {
    const systemAi = { default: { model: "sonnet", reasoning_level: "high" }, planning: { model: "deepseek-v4-flash", reasoning_level: "low" }, execution: { model: null, reasoning_level: null }, repair: { model: null, reasoning_level: null } };
    expect(resolvedAiFor(ticketWithoutOverrides, project, "planning", systemAi))
      .toEqual({ model: "deepseek-v4-flash", reasoning_level: "low" });
  });

  it("still lets a ticket override win over the system tier", () => {
    const systemAi = { default: { model: "sonnet", reasoning_level: "high" }, planning: { model: "deepseek-v4-flash", reasoning_level: "low" }, execution: { model: null, reasoning_level: null }, repair: { model: null, reasoning_level: null } };
    const ticket = { ...ticketWithoutOverrides, planning_model: "opus", planning_reasoning_level: "max" };
    expect(resolvedAiFor(ticket, project, "planning", systemAi))
      .toEqual({ model: "opus", reasoning_level: "max" });
  });
});
