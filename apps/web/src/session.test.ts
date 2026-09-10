import { expect, test, vi } from "vitest";

vi.mock("@dcc/database", () => ({ pool: { query: vi.fn() } }));

const { assertAdmin } = await import("./session.ts");

test("rejects a reporter at the shared admin API boundary", () => {
  expect(() => assertAdmin({
    id: "session", user_id: "reporter", username: "reporter", role: "reporter", csrf_token_hash: "hash",
  })).toThrow(expect.objectContaining({ status: 403, message: "administrator access required" }));
});

test("accepts an administrator at the shared admin API boundary", () => {
  expect(() => assertAdmin({
    id: "session", user_id: "admin", username: "admin", role: "admin", csrf_token_hash: "hash",
  })).not.toThrow();
});
