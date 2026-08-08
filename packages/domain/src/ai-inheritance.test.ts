import { describe, expect, it } from "vitest";
import { resolveAiConfiguration } from "./index.ts";

const nullSelection = { model: null, reasoning_level: null };
const nullTicket = {
  default: nullSelection, planning: nullSelection,
  execution: nullSelection, repair: nullSelection,
};

describe("ticket AI inheritance", () => {
  it("a ticket with all-null AI columns inherits the system planning model", () => {
    const resolved = resolveAiConfiguration({
      phase: "planning",
      system: {
        default: { model: "deepseek-v4-pro", reasoning_level: "high" },
        planning: { model: "deepseek-v4-pro", reasoning_level: "high" },
      },
      project: undefined,
      ticket: nullTicket,
    });
    expect(resolved).toEqual({ model: "deepseek-v4-pro", reasoning_level: "high" });
  });

  it("an explicit ticket default still overrides the system setting", () => {
    const resolved = resolveAiConfiguration({
      phase: "planning",
      system: { default: { model: "deepseek-v4-pro", reasoning_level: "high" } },
      ticket: { ...nullTicket, default: { model: "sonnet", reasoning_level: "high" } },
    });
    expect(resolved.model).toBe("sonnet");
  });
});
