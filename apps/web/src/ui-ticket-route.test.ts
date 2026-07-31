import { describe, expect, it } from "vitest";
import { adminPage } from "./ui.ts";

describe("ticket filter route script", () => {
  it("only restores saved filters on the ticket list", () => {
    const list = adminPage("/admin/tickets", "Tickets", "", {}, "admin");
    const detail = adminPage("/admin/tickets/DCC-1000", "DCC-1000", "", {}, "admin");

    expect(list).toContain('location.replace("/admin/tickets?"+params)');
    expect(detail).not.toContain('location.replace("/admin/tickets?"+params)');
  });
});
