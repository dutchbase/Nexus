import { expect, test, vi } from "vitest";

vi.mock("@dcc/database", () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [{ id: "22222222-2222-4222-8222-222222222222", name: "Website" }] }) },
}));
vi.mock("../reporter-users.ts", () => ({
  listReporters: vi.fn().mockResolvedValue([{ id: "11111111-1111-4111-8111-111111111111", username: "client-one", is_active: true, role: "reporter", project_ids: [], created_at: "2026-09-10T00:00:00Z", last_login_at: null }]),
}));

const { render } = await import("./users.ts");

test("renders account controls, project choices, and inline errors without credentials", async () => {
  const page = await render(new URL("http://test/admin/users"), { role: "admin" } as any, {});
  expect(page?.body).toContain("Add user");
  expect(page?.body).toContain("Initial password");
  expect(page?.body).toContain('autocomplete="new-password"');
  expect(page?.body).toContain('name="project_ids"');
  expect(page?.body).toContain("No assigned projects");
  expect(page?.body).toContain('role="alert" data-user-error');
  expect(page?.body).not.toMatch(/password_hash|test-hash/);
});
