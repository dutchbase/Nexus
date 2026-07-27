import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "child_process";
import {
  login,
  apiJson,
  queryOne,
} from "../helpers";

describe("OPS-02: Dirty repository blocks planning/execution", () => {
  let session: Awaited<ReturnType<typeof login>>;
  const customerPortalRepo = process.env.FIXTURE_REPO_CUSTOMER_PORTAL;

  beforeAll(async () => {
    session = await login();
    if (!customerPortalRepo) {
      throw new Error("FIXTURE_REPO_CUSTOMER_PORTAL env var not set");
    }
  });

  it("should reject approve-planning when repository has uncommitted changes", async () => {
    // customer-portal (project_id ...003) is the dirty fixture
    // DCC-137 is in customer-portal and status is "Rejected" (not already in execution)
    const ticket = await queryOne(
      "select id from tickets where ticket_number = $1",
      ["DCC-137"]
    );
    expect(ticket).toBeDefined();

    const ticketId = ticket.id;
    const res = await apiJson(
      session,
      "POST",
      `/api/admin/tickets/${ticketId}/approve-planning`
    );

    // Should be blocked (4xx error)
    expect(res.ok).toBe(false);
    expect([400, 409, 422]).toContain(res.status);

    // Response should mention dirty repository or changed files
    const responseText = JSON.stringify(res.json || {});
    expect(responseText.toLowerCase()).toMatch(
      /dirty|uncommitted|changed|modified|repository/
    );
  });

  it("should surface changed file list in rejection response", async () => {
    const ticket = await queryOne(
      "select id from tickets where ticket_number = $1",
      ["DCC-137"]
    );
    const ticketId = ticket.id;

    const res = await apiJson(
      session,
      "POST",
      `/api/admin/tickets/${ticketId}/approve-planning`
    );

    // Response should either:
    // 1. Include a changed_files array, or
    // 2. Mention the specific file (README.md) that is uncommitted
    const responseJson = res.json || {};
    const responseStr = JSON.stringify(responseJson);
    expect(responseStr).toMatch(/README\.md|changed|files|modifications/i);
  });

  it("should never auto-reset the dirty checkout", async () => {
    // Record git status before the blocked approval attempt
    const statusBefore = execSync(`git -C "${customerPortalRepo}" status --porcelain`, {
      encoding: "utf8",
    });

    // Attempt to approve-planning (which will be rejected)
    const ticket = await queryOne(
      "select id from tickets where ticket_number = $1",
      ["DCC-137"]
    );
    const ticketId = ticket.id;
    await apiJson(session, "POST", `/api/admin/tickets/${ticketId}/approve-planning`);

    // Record git status after the blocked attempt
    const statusAfter = execSync(`git -C "${customerPortalRepo}" status --porcelain`, {
      encoding: "utf8",
    });

    // Fixture repository should remain dirty (byte-identical status output)
    expect(statusBefore).toBe(statusAfter);
    expect(statusBefore).not.toBe("");
  });

  it("customer-portal project health reflects repository_dirty state", async () => {
    // Verify the fixture state is as expected: customer-portal marked as dirty
    const project = await queryOne(
      "select health_status from projects where slug = $1",
      ["customer-portal"]
    );
    expect(project).toBeDefined();
    expect(project.health_status).toBe("repository_dirty");
  });
});
