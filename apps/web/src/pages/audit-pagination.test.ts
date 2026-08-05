import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("@dcc/database", () => ({ pool: { query } }));

const audit = await import("./audit.ts");
const session = { username: "admin", user_id: "admin" };

function eventRow(index: number) {
  return {
    id: `event-${index}`,
    action: "ticket.created",
    entity_type: "ticket",
    entity_id: "ticket-1",
    actor_type: "admin",
    actor_id: "admin",
    ip_address: "127.0.0.1",
    created_at: `2026-08-0${(index % 9) + 1}T00:00:00Z`,
  };
}

beforeEach(() => {
  query.mockReset();
});

describe("audit log pagination", () => {
  it("uses a stable keyset order and a parameterized LIMIT, applying the cursor from the URL", async () => {
    query.mockResolvedValue({ rows: [eventRow(1)] });

    await audit.render(new URL("http://test/admin/audit?cursor=2026-01-01T00%3A00%3A00Z%2Cevent-0"), session, {});

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0];
    expect(sql).toMatch(/ORDER BY ae\.created_at DESC, ae\.id DESC/);
    expect(sql).toMatch(/LIMIT \$\d+/);
    expect(sql).not.toMatch(/LIMIT 200/);
    expect(sql).toMatch(/WHERE.*\(ae\.created_at, ae\.id\) < \(\$\d+, \$\d+\)/);
    expect(values).toContain("2026-01-01T00:00:00Z");
    expect(values).toContain("event-0");
  });

  it("shows a pager link when a full page of results comes back, and omits it on a short page", async () => {
    const fullPage = Array.from({ length: 50 }, (_, index) => eventRow(index));
    query.mockResolvedValue({ rows: fullPage });

    const full = await audit.render(new URL("http://test/admin/audit"), session, {});
    expect(full?.body).toContain("data-pager-next");
    expect(full?.body).toContain("cursor=");

    query.mockResolvedValue({ rows: [eventRow(1)] });
    const short = await audit.render(new URL("http://test/admin/audit"), session, {});
    expect(short?.body).not.toContain("data-pager-next");
  });
});
