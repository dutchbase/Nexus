import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const inTransaction = vi.fn();
vi.mock("@dcc/database", () => ({ inTransaction, pool: { query } }));

const operate = await import("./operate.ts");
const session = { username: "admin", user_id: "admin" };

beforeEach(() => {
  query.mockReset();
  query.mockImplementation(async (sql: string) => {
    if (!sql) return { rows: [] };
    if (sql.includes("FROM ai_review_settings")) return { rows: [{ default_model: "sonnet", default_reasoning_level: "medium" }] };
    if (sql.includes("FROM github_capability")) return { rows: [] };
    return { rows: [] };
  });
});

describe("capabilityLabel", () => {
  it("reports read + write access with a recency label", () => {
    const label = operate.capabilityLabel({ status: "ok", can_read: true, can_write: true, reason: null, checked_at: new Date().toISOString() });
    expect(label).toContain("read + write");
    expect(label).toContain("checked");
  });

  it("reports read-only access", () => {
    const label = operate.capabilityLabel({ status: "ok", can_read: true, can_write: false, reason: null, checked_at: new Date().toISOString() });
    expect(label).toContain("read only");
    expect(label).not.toContain("write");
  });

  it("reports unauthorized access with the captured reason", () => {
    const label = operate.capabilityLabel({ status: "unauthorized", can_read: false, can_write: false, reason: "token lacks repo scope", checked_at: new Date().toISOString() });
    expect(label).toContain("unauthorized");
    expect(label).toContain("token lacks repo scope");
  });

  it("reports never checked when no probe has run", () => {
    expect(operate.capabilityLabel(null)).toBe("never checked");
  });
});

describe("settings page GitHub panel", () => {
  it("renders configuration intent as unverified and drops the fake verified checkboxes", async () => {
    const page = await operate.render(new URL("http://test/admin/settings"), session, {});

    expect(page?.body).toContain("Configuration intent");
    expect(page?.body).not.toContain("checked disabled>Always open pull requests as draft");
    expect(page?.body).not.toContain("checked disabled>Automatic merge permanently disabled");
  });

  it("shows GitHub access as never checked when no capability row exists", async () => {
    const page = await operate.render(new URL("http://test/admin/settings"), session, {});

    expect(page?.body).toContain("GitHub access");
    expect(page?.body).toContain("never checked");
  });

  it("surfaces a probed capability row in the settings body", async () => {
    query.mockImplementation(async (sql: string) => {
      if (!sql) return { rows: [] };
      if (sql.includes("FROM ai_review_settings")) return { rows: [{ default_model: "sonnet", default_reasoning_level: "medium" }] };
      if (sql.includes("FROM github_capability")) return { rows: [{ id: 1, status: "ok", can_read: true, can_write: true, reason: null, checked_at: new Date().toISOString() }] };
      return { rows: [] };
    });

    const page = await operate.render(new URL("http://test/admin/settings"), session, {});

    expect(page?.body).toContain("read + write");
  });
});

describe("settings page model prices", () => {
  it("renders active and historic model prices with their provenance", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM ai_review_settings")) return { rows: [{ default_model: "sonnet", default_reasoning_level: "medium" }] };
      if (sql.includes("FROM ai_model_prices")) return { rows: [
        { id: "current", model: "sonnet", effective_from: "2026-08-08T00:00:00Z", input_usd_per_million: "3", output_usd_per_million: "15", cache_write_usd_per_million: "3.75", cache_read_usd_per_million: "0.3", source_url: "https://example.test/current", creator: "admin", is_active: true },
        { id: "old", model: "sonnet", effective_from: "2026-01-01T00:00:00Z", input_usd_per_million: "2", output_usd_per_million: "10", cache_write_usd_per_million: "2.5", cache_read_usd_per_million: "0.2", source_url: "https://example.test/old", creator: "former-admin", is_active: false },
      ] };
      return { rows: [] };
    });

    const page = await operate.render(new URL("http://test/admin/settings"), session, {});

    expect(page?.body).toContain("Model pricing");
    expect(page?.body).toContain("Active");
    expect(page?.body).toContain("Historic");
    expect(page?.body).toContain("https://example.test/current");
    expect(page?.body).toContain("former-admin");
    expect(page?.body).toContain('data-ai-model-price-form');
  });
});
