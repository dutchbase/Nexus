import { beforeEach, expect, test, vi } from "vitest";

process.env.DCC_PROCESS_ROLE = "web";

const pool = { query: vi.fn() };
let transactionClient: any;
const inTransaction = vi.fn(async (callback: (client: any) => unknown) => callback(transactionClient));
vi.mock("@dcc/database", () => ({
  artifactDataRoot: () => "/primary", legacyArtifactDataRoot: () => "/legacy",
  finalizeArtifact: vi.fn(), inTransaction, pool,
  readArtifact: vi.fn(), readStagedArtifact: vi.fn(), stageArtifact: vi.fn(),
}));

const ensurePolicySnapshot = vi.hoisted(() => vi.fn());
vi.mock("@dcc/domain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dcc/domain")>()),
  ensurePolicySnapshot,
}));

const { adminApi } = await import("./server.ts");

function request(body: unknown, method = "PATCH") {
  return {
    method, headers: {}, socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
  } as any;
}

beforeEach(() => {
  pool.query.mockReset();
  inTransaction.mockClear();
  ensurePolicySnapshot.mockReset();
});

const pullRequestApprovalPath = "http://test/api/admin/pull-requests/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/approve";

test("pull-request approval rejects a browser request without a head and policy binding", async () => {
  pool.query.mockResolvedValueOnce({ rows: [{
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", head_sha: "head-sha",
    current_policy_snapshot_id: "snapshot-1", policy_stale: false,
  }] }).mockResolvedValueOnce({ rows: [{ require_fresh_policy_binding: true }] });
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({}, "POST"), response, new URL(pullRequestApprovalPath), { user_id: "admin" });

  expect(response.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
  expect(pool.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO jobs"))).toBe(false);
});

test("pull-request approval rejects a stale browser policy binding", async () => {
  pool.query.mockImplementation(async (sql: string) => sql.includes("FROM pull_request_merge_settings")
    ? { rows: [{ require_fresh_policy_binding: true }] }
    : { rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", head_sha: "new-head", current_policy_snapshot_id: "snapshot-2", policy_stale: false }] });
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({ expected_head_sha: "old-head", policy_snapshot_id: "snapshot-1" }, "POST"),
    response, new URL(pullRequestApprovalPath), { user_id: "admin" });

  expect(response.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
  expect(pool.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO jobs"))).toBe(false);
});

test("pull-request approval queues a matching head without a policy snapshot when enforcement is disabled", async () => {
  pool.query.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM pull_request_merge_settings")) return { rows: [{ require_fresh_policy_binding: false }] };
    if (sql.includes("FROM pull_requests pr")) return { rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", head_sha: "head-sha", current_policy_snapshot_id: null, policy_stale: true }] };
    if (sql.includes("INSERT INTO jobs")) return { rows: [{ id: "job-1", payload_json: values?.[2] }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({ expected_head_sha: "head-sha" }, "POST"), response, new URL(pullRequestApprovalPath), { user_id: "admin" });

  const queued = pool.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO jobs"));
  expect(queued?.[1]?.[2]).toEqual({ actor_id: "admin", pull_request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", expected_head_sha: "head-sha" });
  expect(response.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
});

test("pull-request merge setting rejects non-boolean values", async () => {
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({ require_fresh_policy_binding: "false" }, "POST"), response, new URL("http://test/api/admin/settings/pull-request-merge"), { user_id: "admin" });

  expect(response.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  expect(pool.query).not.toHaveBeenCalled();
});

test("pull-request merge setting updates the singleton and audits the actor", async () => {
  pool.query.mockResolvedValue({ rows: [], rowCount: 1 });
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({ require_fresh_policy_binding: true }, "POST"), response, new URL("http://test/api/admin/settings/pull-request-merge"), { user_id: "admin" });

  const update = pool.query.mock.calls.find(([sql]) => sql.includes("UPDATE pull_request_merge_settings"));
  const audit = pool.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO audit_events"));
  expect(update?.[1]).toEqual([true]);
  expect(audit?.[1]?.slice(0, 7)).toEqual(["admin", "admin", "pull_request_merge_settings.update", "pull_request_merge_settings", "1", null, { require_fresh_policy_binding: true }]);
  expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
});

test("pull-request approval queues the exact current head and policy binding", async () => {
  pool.query.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM pull_request_merge_settings")) return { rows: [{ require_fresh_policy_binding: true }] };
    if (sql.includes("FROM pull_requests pr")) return { rows: [{
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", head_sha: "head-sha",
      current_policy_snapshot_id: "snapshot-1", policy_stale: false,
      policy_complete: true, review_state: "approved", check_state: "success",
    }] };
    if (sql.includes("INSERT INTO jobs")) return { rows: [{ id: "job-1", payload_json: values?.[2] }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({ expected_head_sha: "head-sha", policy_snapshot_id: "snapshot-1" }, "POST"),
    response, new URL(pullRequestApprovalPath), { user_id: "admin" });

  const queued = pool.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO jobs"));
  expect(queued?.[1]?.[2]).toEqual({
    actor_id: "admin", pull_request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    expected_head_sha: "head-sha", policy_snapshot_id: "snapshot-1",
  });
  expect(response.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
});

test("approves a PR with no policy snapshot when the project has no applicable GitHub policies (auto mode)", async () => {
  pool.query.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM pull_request_merge_settings")) return { rows: [{ require_fresh_policy_binding: true }] };
    if (sql.includes("FROM pull_requests pr")) return { rows: [{
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", head_sha: "head-sha", number: 7,
      github_owner: "acme", github_repository: "widgets", config_json: {},
      current_policy_snapshot_id: null, policy_stale: true,
    }] };
    if (sql.includes("SELECT review_state, check_state, policy_complete FROM pull_requests")) {
      return { rows: [{ review_state: "not_required", check_state: "not_required", policy_complete: true }] };
    }
    if (sql.includes("INSERT INTO jobs")) return { rows: [{ id: "job-1", payload_json: values?.[2] }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  ensurePolicySnapshot.mockResolvedValue({ outcome: "synced", snapshotId: "fresh-snapshot" });
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({ expected_head_sha: "head-sha" }, "POST"), response, new URL(pullRequestApprovalPath), { user_id: "admin" });

  expect(ensurePolicySnapshot).toHaveBeenCalledWith(pool, {
    pullRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", owner: "acme", repo: "widgets", number: 7,
  });
  const queued = pool.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO jobs"));
  expect(queued?.[1]?.[2]).toEqual({
    actor_id: "admin", pull_request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    expected_head_sha: "head-sha", policy_snapshot_id: "fresh-snapshot",
  });
  expect(response.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
});

test("keeps blocking a PR with no policy snapshot when the project requires enforcement", async () => {
  pool.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM pull_request_merge_settings")) return { rows: [{ require_fresh_policy_binding: true }] };
    if (sql.includes("FROM pull_requests pr")) return { rows: [{
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", head_sha: "head-sha", number: 7,
      github_owner: "acme", github_repository: "widgets", config_json: { github_policy: { enforcement: "required" } },
      current_policy_snapshot_id: null, policy_stale: true,
    }] };
    return { rows: [], rowCount: 1 };
  });
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({ expected_head_sha: "head-sha" }, "POST"), response, new URL(pullRequestApprovalPath), { user_id: "admin" });

  expect(ensurePolicySnapshot).not.toHaveBeenCalled();
  expect(response.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
  expect(response.end).toHaveBeenCalledWith(expect.stringContaining("policy snapshot missing"));
  expect(pool.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO jobs"))).toBe(false);
});

test.each([
  ["failing required checks", { review_state: "approved", check_state: "failure" }, "checks failed"],
  ["pending required checks", { review_state: "approved", check_state: "pending" }, "checks pending"],
  ["a changes-requested review", { review_state: "changes_requested", check_state: "success" }, "changes requested"],
])("refuses a protected repo with %s before queueing a merge job", async (_name, policy, reason) => {
  pool.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM pull_request_merge_settings")) return { rows: [{ require_fresh_policy_binding: true }] };
    if (sql.includes("FROM pull_requests pr")) return { rows: [{
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", head_sha: "head-sha", number: 7,
      github_owner: "acme", github_repository: "widgets", config_json: {},
      current_policy_snapshot_id: "snapshot-1", policy_stale: false, policy_complete: true, ...policy,
    }] };
    return { rows: [], rowCount: 1 };
  });
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({ expected_head_sha: "head-sha" }, "POST"), response, new URL(pullRequestApprovalPath), { user_id: "admin" });

  expect(ensurePolicySnapshot).not.toHaveBeenCalled();
  expect(response.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
  expect(response.end).toHaveBeenCalledWith(expect.stringContaining(reason));
  expect(pool.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO jobs"))).toBe(false);
});

test("keeps blocking and surfaces the real error when GitHub is unreachable during on-demand sync", async () => {
  pool.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM pull_request_merge_settings")) return { rows: [{ require_fresh_policy_binding: true }] };
    if (sql.includes("FROM pull_requests pr")) return { rows: [{
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", head_sha: "head-sha", number: 7,
      github_owner: "acme", github_repository: "widgets", config_json: {},
      current_policy_snapshot_id: null, policy_stale: true,
    }] };
    return { rows: [], rowCount: 1 };
  });
  ensurePolicySnapshot.mockResolvedValue({ outcome: "error", errorCode: "rate_limited", retryAfter: null });
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({ expected_head_sha: "head-sha" }, "POST"), response, new URL(pullRequestApprovalPath), { user_id: "admin" });

  expect(response.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
  expect(response.end).toHaveBeenCalledWith(expect.stringContaining("rate_limited"));
  expect(pool.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO jobs"))).toBe(false);
});

test.each(["Rejected", "Plan Approved"])("generic ticket PATCH rejects raw %s transitions", async (status) => {
  const response: any = { writeHead: vi.fn(), end: vi.fn() };
  await adminApi(request({ status }), response, new URL("http://test/api/admin/tickets/ticket"), { user_id: "admin" });
  expect(response.writeHead).toHaveBeenCalledWith(422, expect.any(Object));
  expect(response.end).toHaveBeenCalledWith(JSON.stringify({ error: "status must use its decision endpoint" }));
});

test("generic ticket PATCH cannot forge the worker-authorized queued status", async () => {
  const response: any = { writeHead: vi.fn(), end: vi.fn() };
  await adminApi(request({ status: "Execution Queued" }), response, new URL("http://test/api/admin/tickets/ticket"), { user_id: "admin" });
  expect(response.writeHead).toHaveBeenCalledWith(422, expect.any(Object));
  expect(response.end).toHaveBeenCalledWith(JSON.stringify({ error: "status cannot be set manually" }));
});

test("execution queueing binds the job to the exact approved input snapshot", async () => {
  const approvedInput = {
    plan: { versionId: "plan-version", version: 1, contentHash: "plan-hash" },
    ticket: { title: "Approved title" },
    project: { configVersion: 1, config: {} }, models: {}, prompts: [], skills: [], policySources: [],
  };
  const { materialInput, inputHash } = (await import("@dcc/domain")).buildApprovedInputSnapshot(approvedInput as any);
  const gateRow = {
    id: "ticket", status: "Plan Approved", approved_plan_version_id: "plan-version",
    approved_input_snapshot_id: "approved-input-1", gate_snapshot_id: "approved-input-1",
    snapshot_ticket_id: "ticket", snapshot_plan_version_id: "plan-version",
    snapshot_material_input: materialInput, snapshot_input_hash: inputHash,
    gate_plan_version_id: "plan-version", current_version_id: "plan-version",
    approved_plan_hash: "plan-hash", current_content_hash: "plan-hash", potentially_stale: false, plan_id: "plan",
  };
  pool.query.mockImplementation(async (sql: string) => sql.includes("id::text=$1")
    ? { rows: [{ id: "ticket" }] }
    : { rows: [gateRow] });
  transactionClient = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM tickets t")) return { rows: [{ ...gateRow, status: "Plan Approved" }] };
    if (sql.includes("max(attempt_number)")) return { rows: [{ next: 1 }] };
    if (sql.includes("FROM execution_attempts")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO execution_attempts")) return { rows: [{ id: "attempt-1" }] };
    if (sql.includes("INSERT INTO jobs")) return { rows: [{ id: "job-1", payload_json: values?.[2] }] };
    return { rows: [], rowCount: 1 };
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({}, "POST"), response, new URL("http://test/api/admin/tickets/ticket/execute"), { user_id: "admin" });

  const queued = transactionClient.query.mock.calls.find(([sql]: [string]) => sql.includes("INSERT INTO jobs"));
  expect(queued[1][2]).toMatchObject({ approved_input_snapshot_id: "approved-input-1" });
  expect(response.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
});

test("execution retries a failed ticket with the approved plan and input snapshot", async () => {
  const approvedInput = {
    plan: { versionId: "plan-version", version: 1, contentHash: "plan-hash" },
    ticket: { title: "Approved title" },
    project: { configVersion: 1, config: {} }, models: {}, prompts: [], skills: [], policySources: [],
  };
  const { materialInput, inputHash } = (await import("@dcc/domain")).buildApprovedInputSnapshot(approvedInput as any);
  const gateRow = {
    id: "ticket", status: "Execution Failed", approved_plan_version_id: "plan-version",
    approved_input_snapshot_id: "approved-input-1", gate_snapshot_id: "approved-input-1",
    snapshot_ticket_id: "ticket", snapshot_plan_version_id: "plan-version",
    snapshot_material_input: materialInput, snapshot_input_hash: inputHash,
    gate_plan_version_id: "plan-version", current_version_id: "plan-version",
    approved_plan_hash: "plan-hash", current_content_hash: "plan-hash", potentially_stale: false, plan_id: "plan",
  };
  pool.query.mockImplementation(async (sql: string) => sql.includes("id::text=$1")
    ? { rows: [{ id: "ticket" }] }
    : { rows: [gateRow] });
  transactionClient = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM tickets t")) return { rows: [gateRow] };
    if (sql.includes("max(attempt_number)")) return { rows: [{ next: 2 }] };
    if (sql.includes("FROM execution_attempts")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO execution_attempts")) return { rows: [{ id: "attempt-2" }] };
    if (sql.includes("INSERT INTO jobs")) return { rows: [{ id: "job-2", payload_json: values?.[2] }] };
    return { rows: [], rowCount: 1 };
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({}, "POST"), response, new URL("http://test/api/admin/tickets/ticket/execute"), { user_id: "admin" });

  const attempt = transactionClient.query.mock.calls.find(([sql]: [string]) => sql.includes("INSERT INTO execution_attempts"));
  const queued = transactionClient.query.mock.calls.find(([sql]: [string]) => sql.includes("INSERT INTO jobs"));
  expect(attempt[1]).toEqual(["ticket", "plan-version", 2]);
  expect(queued[1][0]).toBe("execution.run");
  expect(queued[1][2]).toMatchObject({ plan_version_id: "plan-version", approved_input_snapshot_id: "approved-input-1" });
  expect(response.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
});

test("revision from execution failure clears approval and queues planning revision", async () => {
  pool.query.mockResolvedValue({ rows: [{
    ticket_id: "ticket", current_version_id: "plan-version", status: "Execution Failed",
    ticket_version: "2026-08-09T10:00:00Z", approved_input_snapshot_id: "approved-input-1",
  }] });
  transactionClient = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM plans p JOIN tickets t") && sql.includes("FOR UPDATE")) return { rows: [{ id: "plan", ticket_id: "ticket" }] };
    if (sql.includes("SELECT * FROM plan_versions")) return { rows: [{ id: "plan-version", version: 1 }] };
    if (sql.includes("UPDATE tickets t SET status='Plan Revision Requested'")) return { rows: [{ id: "ticket" }] };
    if (sql.includes("INSERT INTO plan_review_feedback")) return { rows: [{ id: "feedback-1" }] };
    if (sql.includes("INSERT INTO jobs")) return { rows: [{ id: "job-1", payload_json: values?.[2] }] };
    if (sql.includes("UPDATE tickets SET status='Plan Revision Queued'")) return { rows: [{ id: "ticket" }] };
    return { rows: [], rowCount: 1 };
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({ feedback: "Revise the failed execution plan." }, "POST"), response,
    new URL("http://test/api/admin/plans/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/request-revision"), { user_id: "admin" });

  const cleared = transactionClient.query.mock.calls.find(([sql]: [string]) => sql.includes("UPDATE tickets t SET status='Plan Revision Requested'"));
  const queued = transactionClient.query.mock.calls.find(([sql]: [string]) => sql.includes("INSERT INTO jobs"));
  expect(cleared[0]).toContain("approved_plan_version_id=NULL");
  expect(cleared[0]).toContain("approved_input_snapshot_id=NULL");
  expect(queued[1][2]).toMatchObject({ ticket_id: "ticket", plan_id: "plan", plan_version_id: "plan-version", feedback_id: "feedback-1" });
  expect(response.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
});

test("repair queueing keeps the originating execution snapshot binding", async () => {
  transactionClient = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM agent_runs ar")) return { rows: [{
      id: "a1", ticket_id: "ticket", execution_attempt_id: "attempt-1",
      plan_version_id: "plan-version", validation_status: "failed", worktree_path: "/worktree",
      ticket_status: "Execution Failed", metadata_json: { approved_input_snapshot_id: "approved-input-1" },
    }] };
    if (sql.includes("max(attempt_number)")) return { rows: [{ next: 2 }] };
    if (sql.includes("SELECT status FROM jobs")) return { rows: [{ status: "failed" }] };
    if (sql.includes("FROM jobs")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO execution_attempts")) return { rows: [{ id: "repair-attempt" }] };
    if (sql.includes("INSERT INTO jobs")) return { rows: [{ id: "repair-job", payload_json: values?.[2] }] };
    return { rows: [], rowCount: 1 };
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({ feedback: "Repair the failed validation." }, "POST"), response,
    new URL("http://test/api/admin/runs/a1/repair"), { user_id: "admin" });

  const queued = transactionClient.query.mock.calls.find(([sql]: [string]) => sql.includes("INSERT INTO jobs"));
  expect(queued[1][2]).toMatchObject({ approved_input_snapshot_id: "approved-input-1" });
  expect(response.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
});

test("repair queueing creates a new attempt linked to immutable source history", async () => {
  transactionClient = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM agent_runs ar")) return { rows: [{
      id: "run-1", ticket_id: "ticket", execution_attempt_id: "source-attempt",
      plan_version_id: "plan-version", validation_status: "failed", worktree_path: "/source-worktree",
      ticket_status: "Execution Failed", attempt_number: 1,
      metadata_json: { approved_input_snapshot_id: "approved-input-1", job_id: "source-job" },
    }] };
    if (sql.includes("max(attempt_number)")) return { rows: [{ next: 2 }] };
    if (sql.includes("SELECT status FROM jobs")) return { rows: [{ status: "failed" }] };
    if (sql.includes("SELECT 1 FROM jobs WHERE id")) return { rows: [{}], rowCount: 1 };
    if (sql.includes("FROM jobs")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO execution_attempts")) return { rows: [{ id: "repair-attempt", attempt_number: 2 }] };
    if (sql.includes("INSERT INTO jobs")) return { rows: [{ id: "repair-job", payload_json: values?.[2] }] };
    return { rows: [], rowCount: 1 };
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({ feedback: "Repair the failed validation." }, "POST"), response,
    new URL("http://test/api/admin/runs/a111/repair"), { user_id: "admin" });

  const inserted = transactionClient.query.mock.calls.find(([sql]: [string]) => sql.includes("INSERT INTO execution_attempts"));
  expect(inserted[1]).toEqual(["ticket", "plan-version", 2, "source-attempt"]);
  const queued = transactionClient.query.mock.calls.find(([sql]: [string]) => sql.includes("INSERT INTO jobs"));
  expect(queued[1][2]).toMatchObject({ execution_attempt_id: "repair-attempt", source_execution_attempt_id: "source-attempt" });
  expect(response.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
});

test("repair queueing rejects a source worktree already reclaimed by cleanup", async () => {
  transactionClient = { query: vi.fn(async (sql: string) => {
    if (sql.includes("FROM agent_runs ar")) return { rows: [{
      id: "run-1", ticket_id: "ticket", execution_attempt_id: "source-attempt",
      plan_version_id: "plan-version", worktree_lifecycle_status: "reclaimed",
      ticket_status: "Execution Failed", metadata_json: { approved_input_snapshot_id: "approved-input-1" },
    }] };
    return { rows: [], rowCount: 0 };
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await expect(adminApi(request({ feedback: "Repair it." }, "POST"), response,
    new URL("http://test/api/admin/runs/a111/repair"), { user_id: "admin" })).rejects.toMatchObject({ status: 409 });
  expect(transactionClient.query.mock.calls.some(([sql]: [string]) => sql.includes("INSERT INTO execution_attempts"))).toBe(false);
});

test.each([
  ["ai-review", "review-1", "pr_ai_reviews"],
  ["resolve-conflicts", "resolution-1", "pr_conflict_resolutions"],
])("%s returns the existing active attempt", async (action, attemptId, table) => {
  pool.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM pull_requests pr")) return { rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] };
    if (sql.includes("ai_review_settings")) return { rows: [{ default_model: "sonnet", default_reasoning_level: "high" }] };
    return { rows: [] };
  });
  transactionClient = { query: vi.fn(async (sql: string) => {
    if (sql.includes("SELECT id FROM pull_requests") && sql.includes("FOR UPDATE")) return { rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] };
    if (sql.includes(`FROM ${table}`)) return { rows: [{ id: attemptId, job_id: "job-1", job_status: "running" }] };
    throw new Error(`unexpected query: ${sql}`);
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({}, "POST"), response,
    new URL(`http://test/api/admin/pull-requests/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${action}`), { user_id: "admin" });

  expect(response.end).toHaveBeenCalledWith(JSON.stringify({ id: attemptId }));
  expect(transactionClient.query).toHaveBeenCalledWith(
    expect.stringContaining("SELECT id FROM pull_requests WHERE id=$1 FOR UPDATE"),
    ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
  );
  expect(transactionClient.query.mock.calls.some(([sql]: [string]) => sql.includes(`INSERT INTO ${table}`))).toBe(false);
});

test.each([
  ["ai-review", "old-review", "pr_ai_reviews"],
  ["resolve-conflicts", "old-resolution", "pr_conflict_resolutions"],
])("%s prioritizes an older active attempt over newer terminal history", async (action, activeId, table) => {
  pool.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM pull_requests pr")) return { rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] };
    if (sql.includes("ai_review_settings")) return { rows: [{ default_model: "sonnet", default_reasoning_level: "high" }] };
    return { rows: [] };
  });
  transactionClient = { query: vi.fn(async (sql: string) => {
    if (sql.includes("SELECT id FROM pull_requests")) return { rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] };
    if (sql.includes(`FROM ${table}`)) {
      if (!sql.includes("CASE WHEN j.status IN ('queued','running') THEN 0 ELSE 1 END")) return { rows: [{ id: "new-terminal", job_id: "terminal-job", job_status: "failed" }] };
      return { rows: [{ id: activeId, job_id: "active-job", job_status: "running" }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({}, "POST"), response,
    new URL(`http://test/api/admin/pull-requests/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${action}`), { user_id: "admin" });

  expect(response.end).toHaveBeenCalledWith(JSON.stringify({ id: activeId }));
  expect(transactionClient.query.mock.calls.some(([sql]: [string]) => sql.includes(`INSERT INTO ${table}`))).toBe(false);
});

test.each([
  ["ai-review", "pr_ai_reviews", "pr_ai_review_id", "pr.ai_review", 3],
  ["resolve-conflicts", "pr_conflict_resolutions", "pr_conflict_resolution_id", "pr.conflict_resolution", 1],
])("%s creates a linked rerun after terminal history", async (action, table, payloadKey, jobType, maxAttempts) => {
  pool.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM pull_requests pr")) return { rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] };
    if (sql.includes("ai_review_settings")) return { rows: [{ default_model: "sonnet", default_reasoning_level: "high" }] };
    return { rows: [] };
  });
  transactionClient = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("SELECT id FROM pull_requests") && sql.includes("FOR UPDATE")) return { rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] };
    if (sql.includes(`FROM ${table}`)) return { rows: [{ id: "old-attempt", job_id: "old-job", job_status: "failed" }] };
    if (sql.includes(`INSERT INTO ${table}`)) return { rows: [{ id: "new-attempt" }] };
    if (sql.includes("SELECT 1 FROM jobs")) return { rows: [{}], rowCount: 1 };
    if (sql.includes("INSERT INTO jobs")) return { rows: [{ id: "new-job", type: jobType, payload_json: values?.[2], rerun_of: values?.[6] }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({}, "POST"), response,
    new URL(`http://test/api/admin/pull-requests/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${action}`), { user_id: "admin" });

  const queued = transactionClient.query.mock.calls.find(([sql]: [string]) => sql.includes("INSERT INTO jobs"));
  expect(queued[1][2]).toMatchObject({ [payloadKey]: "new-attempt" });
  expect(queued[1][4]).toBe(maxAttempts);
  expect(queued[1][6]).toBe("old-job");
  expect(response.end).toHaveBeenCalledWith(JSON.stringify({ id: "new-attempt" }));
});

test.each([
  ["/api/admin/runs/a1/repair", "execution.repair"],
  ["/api/admin/runs/a1/retry", "pull-request.retry"],
])("%s links its retry to the source run job", async (path, jobType) => {
  transactionClient = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM agent_runs ar")) return { rows: [{
      id: "attempt-1", run_id: "a1", ticket_id: "ticket", execution_attempt_id: "attempt-1",
      plan_version_id: "plan-version", validation_status: path.endsWith("/retry") ? "pr_creation_failed" : "failed", worktree_path: "/worktree",
      result_commit: "commit", ticket_status: path.endsWith("/retry") ? "PR Creation Failed" : "Execution Failed",
      publication_id: path.endsWith("/retry") ? "publication-1" : undefined,
      publication_status: path.endsWith("/retry") ? "failed" : undefined,
      publication_idempotency_key: path.endsWith("/retry") ? "execution-publication:attempt-1" : undefined,
      metadata_json: { job_id: "source-job", approved_input_snapshot_id: "approved-input-1" },
    }] };
    if (sql.includes("FROM jobs WHERE status IN")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT status FROM jobs")) return { rows: [{ status: "failed" }], rowCount: 1 };
    if (sql.includes("max(attempt_number)")) return { rows: [{ next: 2 }], rowCount: 1 };
    if (sql.includes("INSERT INTO execution_attempts")) return { rows: [{ id: "repair-attempt" }], rowCount: 1 };
    if (sql.includes("SELECT 1 FROM jobs")) return { rows: [{}], rowCount: 1 };
    if (sql.includes("INSERT INTO jobs")) return { rows: [{ id: "new-job", type: jobType, rerun_of: values?.[6] }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({ feedback: "Repair it." }, "POST"), response, new URL(`http://test${path}`), { user_id: "admin" });

  const queued = transactionClient.query.mock.calls.find(([sql]: [string]) => sql.includes("INSERT INTO jobs"));
  expect(queued[1][6]).toBe("source-job");
});

test.each([
  "/api/admin/runs/a1/repair",
  "/api/admin/runs/a1/retry",
])("%s refuses a rerun while the source job is still active", async (path) => {
  transactionClient = { query: vi.fn(async (sql: string) => {
    if (sql.includes("FROM agent_runs ar")) return { rows: [{
      id: "attempt-1", run_id: "a1", ticket_id: "ticket", execution_attempt_id: "attempt-1",
      plan_version_id: "plan-version", validation_status: "failed", worktree_path: "/worktree",
      result_commit: "commit", ticket_status: path.endsWith("/retry") ? "PR Creation Failed" : "Execution Failed",
      publication_id: path.endsWith("/retry") ? "publication-1" : undefined,
      publication_status: path.endsWith("/retry") ? "failed" : undefined,
      publication_idempotency_key: path.endsWith("/retry") ? "execution-publication:attempt-1" : undefined,
      metadata_json: { job_id: "source-job", approved_input_snapshot_id: "approved-input-1" },
    }] };
    if (sql.includes("FROM jobs WHERE status IN")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT status FROM jobs")) return { rows: [{ status: "running" }], rowCount: 1 };
    if (sql.includes("SELECT 1 FROM jobs")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 1 };
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await expect(adminApi(request({ feedback: "Repair it." }, "POST"), response, new URL(`http://test${path}`), { user_id: "admin" }))
    .rejects.toMatchObject({ status: 409 });
});

test("publication retry requires a failed durable publication", async () => {
  transactionClient = { query: vi.fn(async (sql: string) => {
    if (sql.includes("FROM agent_runs ar")) return { rows: [{
      id: "attempt-1", run_id: "a1", ticket_id: "ticket", plan_version_id: "plan-version",
      result_commit: "commit", validation_status: "pr_creation_failed", ticket_status: "PR Creation Failed", metadata_json: { job_id: "source-job" },
      publication_id: "publication-1", publication_status: "pending",
      publication_idempotency_key: "execution-publication:attempt-1",
    }] };
    return { rows: [], rowCount: 0 };
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await expect(adminApi(request({}, "POST"), response, new URL("http://test/api/admin/runs/a1/retry"), { user_id: "admin" }))
    .rejects.toMatchObject({ status: 409 });
  expect(transactionClient.query.mock.calls.some(([sql]: [string]) => sql.includes("INSERT INTO jobs"))).toBe(false);
});

test("publication retry resets the same intent without changing its external key", async () => {
  transactionClient = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM agent_runs ar")) return { rows: [{
      id: "attempt-1", run_id: "a1", ticket_id: "ticket", plan_version_id: "plan-version",
      result_commit: "commit", validation_status: "pr_creation_failed", ticket_status: "PR Creation Failed", metadata_json: { job_id: "source-job" },
      publication_id: "publication-1", publication_status: "failed",
      publication_idempotency_key: "execution-publication:attempt-1",
    }] };
    if (sql.includes("SELECT status FROM jobs")) return { rows: [{ status: "failed" }], rowCount: 1 };
    if (sql.includes("INSERT INTO jobs")) return { rows: [{ id: "retry-job" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }) };
  const response: any = { writeHead: vi.fn(), end: vi.fn() };

  await adminApi(request({}, "POST"), response, new URL("http://test/api/admin/runs/a1/retry"), { user_id: "admin" });

  const reset = transactionClient.query.mock.calls.find(([sql]: [string]) => sql.includes("UPDATE execution_publications"));
  expect(reset?.[0]).toContain("status='pending'");
  expect(reset?.[0]).not.toContain("idempotency_key");
  expect(reset?.[1]).toContain("publication-1");
  expect(response.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
});
