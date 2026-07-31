import { describe, expect, it } from "vitest";
import { selectedStatusesFrom } from "./tickets.ts";

describe("selectedStatusesFrom", () => {
  it("returns an empty array when no status params are present", () => {
    expect(selectedStatusesFrom(new URL("http://x/admin/tickets"))).toEqual([]);
  });

  it("returns all valid status values from repeated status params", () => {
    const url = new URL("http://x/admin/tickets?status=Completed&status=Archived");
    expect(selectedStatusesFrom(url)).toEqual(["Completed", "Archived"]);
  });

  it("drops values that are not in validStatuses", () => {
    const url = new URL("http://x/admin/tickets?status=Completed&status=NotAStatus");
    expect(selectedStatusesFrom(url)).toEqual(["Completed"]);
  });
});
