import { describe, expect, it } from "vitest";
import { backupStatusCards } from "./operate.ts";

describe("backupStatusCards", () => {
  it("reports backup scheduling and verification as not configured when no operator configuration exists", () => {
    const html = backupStatusCards(undefined, null);

    expect(html).toContain("Backup schedule");
    expect(html).toContain("not configured");
  });

  it("reports the configured external schedule, retention, and latest durable verification", () => {
    const html = backupStatusCards("30", { status: "passed", verified_at: new Date().toISOString() });

    expect(html).toContain("03:15 Europe/Amsterdam");
    expect(html).toContain("30 days");
    expect(html).toContain("passed");
  });

  it.each(["30.0", "+30", " 30", "30 "])("treats unsupported retention value %j as not configured", (retentionDays) => {
    const html = backupStatusCards(retentionDays, null);

    expect(html).toContain("Backup schedule");
    expect(html).toContain("not configured");
    expect(html).not.toContain("03:15 Europe/Amsterdam");
  });
});
