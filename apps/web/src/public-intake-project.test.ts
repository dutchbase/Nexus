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

const { submitPublicForm } = await import("./server.ts");

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

describe("submitPublicForm project assignment", () => {
  test("form with no fixed_project_id and body without project_id/project_slug → 400 with code: project_assignment_required, no INSERT INTO tickets", async () => {
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM form_fields")) return { rows: [] };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("FROM public_submission_attempts")) return { rows: [{ count: 0, reset_seconds: 0 }] };
      if (sql.includes("INSERT INTO public_submission_attempts")) return { rows: [] };
      return { rows: [] };
    });
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("FROM public_submission_attempts")) return { rows: [{ count: 0, reset_seconds: 0 }] };
      if (sql.includes("INSERT INTO public_submission_attempts")) return { rows: [] };
      return { rows: [] };
    });

    const form = { id: "form-1", fixed_project_id: null, settings_json: {} };
    const body = { title: "A bug", description: "It broke" };
    const res = response();

    await submitPublicForm(jsonRequest(body), res, form);

    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    const responseBody = JSON.parse(res.end.mock.calls[0][0]);
    expect(responseBody).toEqual({
      error: "project assignment required",
      code: "project_assignment_required",
    });

    // Verify no INSERT INTO tickets was issued
    const ticketInsert = [...pool.query.mock.calls, ...mockClient.query.mock.calls]
      .find(([sql]: [string]) => sql.includes("INSERT INTO tickets"));
    expect(ticketInsert).toBeUndefined();
  });

  test("explicit project_id that resolves to no enabled project → 400 with code: invalid_project", async () => {
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM form_fields")) return { rows: [] };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("FROM public_submission_attempts")) return { rows: [{ count: 0, reset_seconds: 0 }] };
      if (sql.includes("INSERT INTO public_submission_attempts")) return { rows: [] };
      // Project lookup returns no rows (disabled or not found)
      if (sql.includes("SELECT id FROM projects")) return { rows: [] };
      return { rows: [] };
    });
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("FROM public_submission_attempts")) return { rows: [{ count: 0, reset_seconds: 0 }] };
      if (sql.includes("INSERT INTO public_submission_attempts")) return { rows: [] };
      return { rows: [] };
    });

    const form = { id: "form-1", fixed_project_id: null, settings_json: {} };
    const body = { title: "A bug", description: "It broke", project_id: 999 };
    const res = response();

    await submitPublicForm(jsonRequest(body), res, form);

    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    const responseBody = JSON.parse(res.end.mock.calls[0][0]);
    expect(responseBody).toEqual({
      error: "valid project is required",
      code: "invalid_project",
    });
  });

  test("form with valid fixed_project_id → ticket insert proceeds", async () => {
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM form_fields")) return { rows: [] };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("FROM public_submission_attempts")) return { rows: [{ count: 0, reset_seconds: 0 }] };
      if (sql.includes("INSERT INTO public_submission_attempts")) return { rows: [] };
      // Project lookup succeeds
      if (sql.includes("SELECT id FROM projects")) return { rows: [{ id: 123 }] };
      return { rows: [] };
    });
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("FROM public_submission_attempts")) return { rows: [{ count: 0, reset_seconds: 0 }] };
      if (sql.includes("INSERT INTO public_submission_attempts")) return { rows: [] };
      if (sql.includes("SELECT nextval")) return { rows: [{ number: 42 }] };
      if (sql.includes("INSERT INTO tickets")) {
        return {
          rows: [{ id: 1, ticket_number: "DCC-42", project_id: 123 }],
        };
      }
      if (sql.includes("INSERT INTO ticket_status_history")) return { rows: [] };
      return { rows: [] };
    });

    const form = { id: "form-1", fixed_project_id: 123, settings_json: {} };
    const body = { title: "A bug", description: "It broke" };
    const res = response();

    await submitPublicForm(jsonRequest(body), res, form);

    expect(res.writeHead).toHaveBeenCalledWith(201, expect.any(Object));
    const responseBody = JSON.parse(res.end.mock.calls[0][0]);
    expect(responseBody).toHaveProperty("ticket_number");
    expect(responseBody.ticket_number).toBe("DCC-42");

    // Verify INSERT INTO tickets was issued
    const ticketInsert = [...pool.query.mock.calls, ...mockClient.query.mock.calls]
      .find(([sql]: [string]) => sql.includes("INSERT INTO tickets"));
    expect(ticketInsert).toBeDefined();
  });
});
