import { beforeEach, expect, test, vi } from "vitest";

const listSubmissionProjects = vi.fn();
const listSubmissions = vi.fn();
const getSubmission = vi.fn();
const getSubmissionFields = vi.fn();
const listSubmissionAttachments = vi.fn();

vi.mock("./ticket-submissions.ts", () => ({
  listSubmissionProjects, listSubmissions, getSubmission, getSubmissionFields, listSubmissionAttachments,
}));

const { reporterTicketsPage } = await import("./pages/reporter-tickets.ts");
const { reporterPage } = await import("./reporter-ui.ts");
const session = { id: "s", user_id: "u1", username: "reporter", role: "reporter", csrf_token_hash: "hash" } as const;

beforeEach(() => {
  vi.resetAllMocks();
  listSubmissionProjects.mockResolvedValue([{ id: "p1", name: "Project One", slug: "one", enabled: true }]);
  listSubmissions.mockResolvedValue([]);
  getSubmissionFields.mockResolvedValue([
    { field_key: "title", field_type: "short_text", label: "Title", required: true },
    { field_key: "description", field_type: "long_text", label: "Description", required: true },
  ]);
  listSubmissionAttachments.mockResolvedValue([]);
});

test("renders a ticket-only list without operational data", async () => {
  listSubmissions.mockResolvedValue([{
    id: "t1", ticket_number: "DCC-1", project_id: "p1", project_name: "Project One",
    title: "Broken save", description: "Visible", submission: {}, submission_revision: 1,
    submission_updated_at: "2026-09-10T10:00:00Z", created_at: "2026-09-10T09:00:00Z",
    can_delete: true, operational: "private-execution-log-marker",
  }]);
  const rendered = await reporterTicketsPage.render(new URL("http://test/tickets"), session);
  expect(rendered?.body).toContain('href="/tickets"');
  expect(rendered?.body).toContain("Broken save");
  expect(rendered?.body).not.toContain("private-execution-log-marker");
  expect(rendered?.body).not.toMatch(/href="\/admin|data-start-planning|data-run-stream/);
});

test("ignores a project filter outside the reporter's assigned choices", async () => {
  await reporterTicketsPage.render(new URL("http://test/tickets?project_id=not-a-project"), session);
  expect(listSubmissions).toHaveBeenCalledWith({ userId: "u1", role: "reporter" }, { project_id: undefined, search: undefined });
});

test("escapes submission content and renders only declared edit fields", async () => {
  getSubmission.mockResolvedValue({
    id: "t1", ticket_number: "DCC-1", project_id: "p1", project_name: "Project One",
    title: '<img src=x onerror="alert(1)">', description: "</textarea><script>bad()</script>",
    category: null, priority: null, source_url: null, environment: null, expected_behavior: null,
    actual_behavior: null, reproduction_steps: null, submission: { visible: "safe", secret: "private-execution-log-marker" },
    submission_revision: 3, submission_updated_at: "2026-09-10T10:00:00Z", created_at: "2026-09-10T09:00:00Z",
    can_delete: true,
  });
  getSubmissionFields.mockResolvedValue([
    { field_key: "title", field_type: "short_text", label: "Title", required: true },
    { field_key: "description", field_type: "long_text", label: "Description", required: true },
    { field_key: "visible", field_type: "short_text", label: '<b>Visible</b>', required: true },
  ]);
  const rendered = await reporterTicketsPage.render(new URL("http://test/tickets/DCC-1"), session);
  expect(rendered?.body).toContain('name="submission_revision" value="3"');
  expect(rendered?.body).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  expect(rendered?.body).not.toContain("<script>bad()</script>");
  expect(rendered?.body).not.toContain("private-execution-log-marker");
  expect(rendered?.body).toContain("&lt;b&gt;Visible&lt;/b&gt;");
  expect(rendered?.body).toContain("Delete");
});

test("handles empty assignments, disabled creation projects and ownership", async () => {
  listSubmissionProjects.mockResolvedValue([]);
  let rendered = await reporterTicketsPage.render(new URL("http://test/tickets"), session);
  expect(rendered?.body).toContain("No projects assigned. Ask your Nexus administrator for access.");

  listSubmissionProjects.mockResolvedValue([{ id: "p1", name: "Disabled", slug: "disabled", enabled: false }]);
  getSubmission.mockResolvedValue({
    id: "t1", ticket_number: "DCC-1", project_id: "p1", project_name: "Disabled", title: "Ticket", description: "Body",
    category: null, priority: null, source_url: null, environment: null, expected_behavior: null, actual_behavior: null,
    reproduction_steps: null, submission: {}, submission_revision: 1, submission_updated_at: "2026-09-10T10:00:00Z",
    created_at: "2026-09-10T09:00:00Z", can_delete: false,
  });
  rendered = await reporterTicketsPage.render(new URL("http://test/tickets/DCC-1"), session);
  expect(rendered?.body).not.toContain("data-delete-ticket");
});

test("the reporter shell exposes only ticket navigation and safe form behavior", () => {
  const html = reporterPage("Tickets", '<form data-ticket-form><input name="title"></form>', '<admin>', "nonce-value");
  expect(html).toContain('nonce="nonce-value"');
  expect(html).toContain('name="viewport"');
  expect(html).toContain('href="/tickets"');
  expect(html).toContain("&lt;admin&gt;");
  expect(html).not.toContain('href="/admin');
  expect(html).not.toMatch(/data-start-planning|data-run-stream/);
  expect(html).toContain("This ticket changed. Reload it before saving; your edits are still here.");
  expect(html).toContain("csrfCookie");
  expect(html).toContain('event.key!=="Tab"');
});

test("reporter forms retain required source fields and hide non-submission controls", async () => {
  getSubmission.mockResolvedValue({
    id: "t1", ticket_number: "DCC-1", project_id: "p1", project_name: "Project One", title: "Ticket", description: "Body",
    category: null, priority: null, source_url: null, environment: null, expected_behavior: null, actual_behavior: null,
    reproduction_steps: null, submission: { impact: "high" }, submission_revision: 1,
    submission_updated_at: "2026-09-10T10:00:00Z", created_at: "2026-09-10T09:00:00Z", can_delete: false,
  });
  getSubmissionFields.mockResolvedValue([
    { field_key: "title", field_type: "short_text", label: "Title", required: true },
    { field_key: "description", field_type: "long_text", label: "Description", required: true },
    { field_key: "impact", field_type: "dropdown", label: "Impact", required: true, options_json: ["low", "high"] },
    { field_key: "private", field_type: "hidden", label: "Private", required: false },
    { field_key: "project_id", field_type: "project_selector", label: "Project", required: true },
  ]);
  const rendered = await reporterTicketsPage.render(new URL("http://test/tickets/DCC-1"), session);
  expect(rendered?.body).toContain('<select name="impact" required>');
  expect(rendered?.body).toContain('<option value="high" selected>high</option>');
  expect(rendered?.body).not.toContain('name="private"');
  expect(rendered?.body).not.toContain('name="project_id"');
});
