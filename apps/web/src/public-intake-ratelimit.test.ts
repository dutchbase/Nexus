import { beforeEach, describe, expect, test, vi } from "vitest";

process.env.DCC_PROCESS_ROLE = "web";

const pool = { query: vi.fn() };
let mockClient: any;
const inTransaction = vi.fn(async (callback: (client: any) => unknown) => callback(mockClient));
vi.mock("@dcc/database", () => ({
  artifactDataRoot: () => "/primary",
  legacyArtifactDataRoot: () => "/legacy",
  finalizeArtifact: vi.fn(),
  inTransaction,
  pool,
  readArtifact: vi.fn(),
  readStagedArtifact: vi.fn(),
  stageArtifact: vi.fn(),
}));

const { consumeSubmissionAttempt, submitPublicForm } = await import("./server.ts");

beforeEach(() => {
  pool.query.mockReset();
  inTransaction.mockClear();
  mockClient = { query: vi.fn() };
});

function jsonRequest(body: unknown) {
  return {
    method: "POST",
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
  } as any;
}

function response() {
  return { writeHead: vi.fn(), end: vi.fn() } as any;
}

describe("consumeSubmissionAttempt", () => {
  test("takes an advisory lock before counting", async () => {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("FROM public_submission_attempts")) return { rows: [{ count: 0, reset_seconds: 0 }] };
      return { rows: [] };
    });

    await consumeSubmissionAttempt("form-1", "127.0.0.1", 5);

    const [firstSql] = mockClient.query.mock.calls[0];
    expect(firstSql).toContain("pg_advisory_xact_lock");
  });

  test("rejects and does not insert when the count is at or over the limit", async () => {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("FROM public_submission_attempts")) return { rows: [{ count: 5, reset_seconds: 1800 }] };
      return { rows: [] };
    });

    const result = await consumeSubmissionAttempt("form-1", "127.0.0.1", 5);

    expect(result.allowed).toBe(false);
    expect(result.resetSeconds).toBeGreaterThanOrEqual(1);
    const insertCall = mockClient.query.mock.calls.find(([sql]: [string]) => sql.includes("INSERT INTO public_submission_attempts"));
    expect(insertCall).toBeUndefined();
  });

  test("allows and inserts the attempt row when under the limit", async () => {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("FROM public_submission_attempts")) return { rows: [{ count: 2, reset_seconds: 0 }] };
      return { rows: [] };
    });

    const result = await consumeSubmissionAttempt("form-1", "127.0.0.1", 5);

    expect(result).toEqual({ allowed: true, resetSeconds: 0 });
    const insertCall = mockClient.query.mock.calls.find(([sql]: [string]) => sql.includes("INSERT INTO public_submission_attempts"));
    expect(insertCall).toBeDefined();
    expect(insertCall![1]).toEqual(["form-1", "127.0.0.1", "submission"]);
  });
});

describe("submitPublicForm rate limiting", () => {
  test("responds 429 with retry-after when the hourly budget is exhausted, before any ticket is created", async () => {
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM form_fields")) return { rows: [] };
      return { rows: [] };
    });
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("FROM public_submission_attempts")) return { rows: [{ count: 15, reset_seconds: 900 }] };
      return { rows: [] };
    });
    const form = { id: "form-1", settings_json: {} };
    const body = { title: "A bug", description: "It broke", website: "" };
    const res = response();

    await submitPublicForm(jsonRequest(body), res, form);

    expect(res.writeHead).toHaveBeenCalledWith(429, expect.objectContaining({ "retry-after": "900" }));
    const responseBody = JSON.parse(res.end.mock.calls[0][0]);
    expect(responseBody).toEqual(expect.objectContaining({ code: "rate_limited", retry_after_seconds: 900 }));
    const ticketInsert = [...pool.query.mock.calls, ...mockClient.query.mock.calls]
      .find(([sql]: [string]) => sql.includes("INSERT INTO tickets"));
    expect(ticketInsert).toBeUndefined();
  });
});
