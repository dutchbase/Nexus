import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const inTransaction = vi.fn();
vi.mock("@dcc/database", () => ({ inTransaction, pool: { query } }));

const tickets = await import("./tickets.ts");
const session = { username: "admin", user_id: "admin" };

const ticket = {
  id: "ticket-1", ticket_number: "T-1", project_id: "project-1", project_name: "Project", form_name: null,
  title: "Ticket title", description: "Ticket description", category: "bug", environment: "prod",
  status: "Submitted", created_at: "2026-08-04T10:00:00Z",
};

beforeEach(() => {
  query.mockReset();
  inTransaction.mockReset();
  query.mockImplementation(async (sql: string) => {
    if (!sql) return { rows: [] };
    if (sql.includes("FROM tickets t JOIN projects p")) return { rows: [ticket] };
    return { rows: [] };
  });
});

describe("ticket detail GET", () => {
  it("renders a Submitted ticket as-is without mutating it as a side effect of viewing", async () => {
    const page = await tickets.render(new URL("http://test/admin/tickets/T-1"), session, {});

    expect(page?.body).toContain("Submitted");
    expect(inTransaction).not.toHaveBeenCalled();
    for (const call of query.mock.calls) {
      expect(String(call[0])).not.toMatch(/UPDATE tickets|INSERT INTO ticket_status_history/i);
    }
  });

  it("renders lifecycle summaries from the existing ticket runs query", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM tickets t JOIN projects p")) return { rows: [ticket] };
      if (sql.includes("SELECT * FROM agent_runs")) return { rows: [
        { id: "run-1", run_type: "planning", ai_usage_status: "captured", total_tokens: 42, estimated_cost_usd: "0.002", model: "opus", reasoning_level: "high", status: "completed" },
        { id: "run-2", run_type: "pr_ai_review", ai_usage_status: "unavailable", model: "haiku", reasoning_level: "low", status: "completed" },
      ] };
      return { rows: [] };
    });

    const page = await tickets.render(new URL("http://test/admin/tickets/T-1"), session, {});

    expect(query.mock.calls.some(([sql]) => String(sql).includes("SELECT * FROM agent_runs WHERE ticket_id=$1"))).toBe(true);
    expect(page?.body).toContain("AI usage");
    expect(page?.body).toContain("1 invocations · 42 tokens · $0.002");
    expect(page?.body).toContain("Unavailable 1");
    expect(page?.body).toContain('href="/admin/runs/run-1"');
  });

  it("renders the workflow action matrix", async () => {
    const plan = { id: "plan-version", version: 1, current_version_id: "plan-version", model: "model", reasoning_level: "high", created_at: "2026-08-04T10:00:00Z" };
    const render = async (status: string, approved = false) => {
      query.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM tickets t JOIN projects p")) return { rows: [{ ...ticket, status, approved_plan_version_id: approved ? "plan-version" : null }] };
        if (sql.includes("FROM plans p JOIN plan_versions pv")) return { rows: approved || status === "Plan Ready for Review" ? [plan] : [] };
        if (sql.includes("FROM tickets t") && sql.includes("approved_input_snapshots")) return { rows: [] };
        return { rows: [] };
      });
      return (await tickets.render(new URL("http://test/admin/tickets/T-1"), session, {}))?.body ?? "";
    };

    expect(await render("Triage")).toContain('data-start-planning>Start planning');
    const review = await render("Plan Ready for Review");
    expect(review).toContain('href="/admin/tickets/T-1/plans/1">Review plan</a>');
    expect(review).not.toContain("data-start-planning");
    const approved = await render("Plan Approved", true);
    expect(approved).toContain("data-start-execution");
    expect(approved).toContain('href="/admin/tickets/T-1/plans/1">Update plan</a>');
    const failed = await render("Execution Failed", true);
    expect(failed).toContain(">Retry execution</button>");
    expect(failed).toContain('>Update plan</a>');
    const inProgress = await render("Planning");
    expect(inProgress).not.toContain("data-start-planning");
    expect(inProgress).not.toContain("data-start-execution");
  });

  it("renders editable source-form values but not static fields or attachments", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM tickets t JOIN projects p")) return { rows: [{ ...ticket, form_id: "form-1", title: "Saved title", custom_values_json: { detail: "Saved detail", choices: ["alpha", "beta"], enabled: true } }] };
      if (sql.includes("FROM form_fields")) return { rows: [
        { field_key: "title", field_type: "short_text", label: "Title", required: true, options_json: [] },
        { field_key: "detail", field_type: "long_text", label: "Detail", required: false, options_json: [] },
        { field_key: "choices", field_type: "multi_select", label: "Choices", required: false, options_json: ["alpha", "beta"] },
        { field_key: "enabled", field_type: "checkbox", label: "Enabled", required: false, options_json: [] },
        { field_key: "internal", field_type: "hidden", label: "Internal", required: false, options_json: [] },
        { field_key: "notice", field_type: "static", label: "Notice", required: false, options_json: [] },
        { field_key: "image", field_type: "image_upload", label: "Image", required: false, options_json: [] },
      ] };
      if (sql.includes("SELECT id, slug, name FROM projects")) return { rows: [{ id: "project-1", name: "Project", slug: "project" }] };
      return { rows: [] };
    });

    const body = (await tickets.render(new URL("http://test/admin/tickets/T-1"), session, {}))?.body ?? "";

    expect(body).toMatch(/name="title"[^>]*value="Saved title"/);
    expect(body).toContain('name="detail" rows="5">Saved detail</textarea>');
    expect(body).toMatch(/select name="choices" multiple[^>]*>.*option value="alpha" selected.*option value="beta" selected/s);
    expect(body).toContain('name="enabled" type="checkbox" value="true" checked');
    expect(body).not.toContain('name="internal"');
    expect(body).not.toContain('name="notice"');
    expect(body).not.toContain('name="image"');
  });

  it("renders recovery actions for a failed ticket with a current plan", async () => {
    const { materialInput, inputHash } = (await import("@dcc/domain")).buildApprovedInputSnapshot({
      plan: { versionId: "plan-version", version: 1, contentHash: "plan-hash" },
      ticket: {}, project: {}, models: {}, prompts: [], skills: [], policySources: [],
    } as any);
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM tickets t JOIN projects p")) return { rows: [{
        ...ticket, status: "Execution Failed", approved_plan_version_id: "plan-version", approved_input_snapshot_id: "approved-input-1",
      }] };
      if (sql.includes("FROM tickets t") && sql.includes("approved_input_snapshots")) return { rows: [{
        id: "ticket-1", status: "Execution Failed", approved_plan_version_id: "plan-version",
        approved_input_snapshot_id: "approved-input-1", gate_snapshot_id: "approved-input-1",
        snapshot_ticket_id: "ticket-1", snapshot_plan_version_id: "plan-version",
        snapshot_material_input: materialInput, snapshot_input_hash: inputHash,
        gate_plan_version_id: "plan-version", current_version_id: "plan-version",
        approved_plan_hash: "plan-hash", current_content_hash: "plan-hash", potentially_stale: false, plan_id: "plan",
      }] };
      if (sql.includes("FROM plans p JOIN plan_versions pv")) return { rows: [{ id: "plan-version", version: 1, current_version_id: "plan-version", model: "model", reasoning_level: "high", created_at: "2026-08-04T10:00:00Z" }] };
      return { rows: [] };
    });

    const page = await tickets.render(new URL("http://test/admin/tickets/T-1"), session, {});
    const body = page?.body ?? "";

    expect(body).toMatch(/data-start-execution(?![^>]*\bdisabled\b)[^>]*>Retry execution/);
    expect(body).toContain('href="/admin/tickets/T-1/plans/1"');
    expect(body).toContain(">Update plan</a>");
  });

  it("keeps plan revision available when failed execution cannot be retried", async () => {
    const { materialInput, inputHash } = (await import("@dcc/domain")).buildApprovedInputSnapshot({
      plan: { versionId: "plan-version", version: 1, contentHash: "plan-hash" },
      ticket: {}, project: {}, models: {}, prompts: [], skills: [], policySources: [],
    } as any);
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM tickets t JOIN projects p")) return { rows: [{
        ...ticket, status: "Execution Failed", approved_plan_version_id: "plan-version", approved_input_snapshot_id: "approved-input-1",
      }] };
      if (sql.includes("FROM tickets t") && sql.includes("approved_input_snapshots")) return { rows: [{
        id: "ticket-1", status: "Execution Failed", approved_plan_version_id: "plan-version",
        approved_input_snapshot_id: "approved-input-1", gate_snapshot_id: "approved-input-1",
        snapshot_ticket_id: "ticket-1", snapshot_plan_version_id: "plan-version",
        snapshot_material_input: materialInput, snapshot_input_hash: inputHash,
        gate_plan_version_id: "plan-version", current_version_id: "plan-version",
        approved_plan_hash: "plan-hash", current_content_hash: "plan-hash", potentially_stale: true, plan_id: "plan",
      }] };
      if (sql.includes("FROM plans p JOIN plan_versions pv")) return { rows: [{ id: "plan-version", version: 1, current_version_id: "plan-version", model: "model", reasoning_level: "high", created_at: "2026-08-04T10:00:00Z" }] };
      return { rows: [] };
    });

    const body = (await tickets.render(new URL("http://test/admin/tickets/T-1"), session, {}))?.body ?? "";

    expect(body).toMatch(/data-start-execution[^>]*\bdisabled\b/);
    expect(body).toContain('href="/admin/tickets/T-1/plans/1"');
    expect(body).toContain(">Update plan</a>");
  });
});
