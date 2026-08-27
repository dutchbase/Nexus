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

const { adminApi } = await import("./server.ts");

function request(body: unknown, method = "POST") {
  return {
    method, headers: {}, socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
  } as any;
}

function response() {
  return { writeHead: vi.fn(), end: vi.fn() } as any;
}

function jsonOf(res: any) {
  return JSON.parse(res.end.mock.calls[0][0]);
}

const uuid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;

const basePr = {
  github_owner: "acme", github_repository: "widgets",
  state: "open", is_draft: false, merge_conflicts: false,
  head_sha: "head-sha", current_policy_snapshot_id: "snapshot-1",
  policy_stale: false, policy_complete: true, review_state: "approved", check_state: "success",
};

beforeEach(() => {
  pool.query.mockReset();
  inTransaction.mockClear();
  transactionClient = undefined;
});

const preflightUrl = "http://test/api/admin/pull-requests/bulk/merge-preflight";
const bulkUrl = "http://test/api/admin/pull-requests/bulk";

test("merge-preflight classifies a mix of ready/blocked PRs and includes a reason for each blocked one", async () => {
  const ready = { ...basePr, id: uuid(1), number: 1, title: "Ready PR" };
  const blocked = { ...basePr, id: uuid(2), number: 2, title: "Draft PR", is_draft: true };
  pool.query.mockImplementation(async (sql: string, values?: any[]) => {
    if (sql.includes("FROM pull_request_merge_settings")) return { rows: [{ require_fresh_policy_binding: true }] };
    if (sql.includes("SELECT * FROM pull_requests WHERE id = ANY")) {
      const ids: string[] = values![0];
      return { rows: [ready, blocked].filter((row) => ids.includes(row.id)) };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const res = response();

  await adminApi(request({ ids: [ready.id, blocked.id] }), res, new URL(preflightUrl), { user_id: "admin" });

  expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  const body = jsonOf(res);
  expect(body.results).toEqual([
    { id: ready.id, number: 1, title: "Ready PR", eligible: true },
    { id: blocked.id, number: 2, title: "Draft PR", eligible: false, reason: expect.stringMatching(/draft/i) },
  ]);
});

test("merge-preflight rejects a non-array/empty ids", async () => {
  const res = response();
  await adminApi(request({ ids: [] }), res, new URL(preflightUrl), { user_id: "admin" });
  expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  expect(pool.query).not.toHaveBeenCalled();

  const res2 = response();
  await adminApi(request({ ids: "not-an-array" }), res2, new URL(preflightUrl), { user_id: "admin" });
  expect(res2.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
});

test("bulk ai-review queues eligible open PRs and skips a PR with an already-running review", async () => {
  const fresh = { ...basePr, id: uuid(3), number: 3, title: "Fresh" };
  const running = { ...basePr, id: uuid(4), number: 4, title: "Running" };
  pool.query.mockImplementation(async (sql: string, values?: any[]) => {
    if (sql.includes("SELECT pr.*,p.github_owner,p.github_repository")) {
      const ids: string[] = values![0];
      return { rows: [fresh, running].filter((row) => ids.includes(row.id)) };
    }
    if (sql.includes("FROM ai_review_settings")) return { rows: [{ default_model: "sonnet", default_reasoning_level: "high" }] };
    if (sql.includes("INSERT INTO audit_events")) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected pool query: ${sql}`);
  });
  transactionClient = { query: vi.fn(async (sql: string, values?: any[]) => {
    if (sql.includes("SELECT id FROM pull_requests") && sql.includes("FOR UPDATE")) return { rows: [{ id: values![0] }] };
    if (sql.includes("FROM pr_ai_reviews")) {
      const pullRequestId = values![0];
      if (pullRequestId === running.id) return { rows: [{ id: "existing-review", job_id: "job-existing", job_status: "running" }] };
      return { rows: [] };
    }
    if (sql.includes("INSERT INTO pr_ai_reviews")) return { rows: [{ id: "new-review" }] };
    if (sql.includes("INSERT INTO jobs")) return { rows: [{ id: "job-new" }], rowCount: 1 };
    throw new Error(`unexpected transaction query: ${sql}`);
  }) };
  const res = response();

  await adminApi(request({ action: "ai-review", ids: [fresh.id, running.id] }), res, new URL(bulkUrl), { user_id: "admin" });

  expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  const body = jsonOf(res);
  expect(body.results).toEqual(expect.arrayContaining([
    { id: fresh.id, outcome: "queued" },
    { id: running.id, outcome: "skipped", reason: "AI review already running" },
  ]));
});

test("bulk ai-review continues processing the rest of the batch after one PR's lookup throws", async () => {
  const good = { ...basePr, id: uuid(5), number: 5, title: "Good" };
  const bad = { ...basePr, id: uuid(6), number: 6, title: "Bad" };
  pool.query.mockImplementation(async (sql: string, values?: any[]) => {
    if (sql.includes("SELECT pr.*,p.github_owner,p.github_repository")) {
      const ids: string[] = values![0];
      return { rows: [good, bad].filter((row) => ids.includes(row.id)) };
    }
    if (sql.includes("FROM ai_review_settings")) return { rows: [{ default_model: "sonnet", default_reasoning_level: "high" }] };
    if (sql.includes("INSERT INTO audit_events")) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected pool query: ${sql}`);
  });
  transactionClient = { query: vi.fn(async (sql: string, values?: any[]) => {
    if (sql.includes("SELECT id FROM pull_requests") && sql.includes("FOR UPDATE")) {
      if (values![0] === bad.id) throw new Error("db exploded");
      return { rows: [{ id: values![0] }] };
    }
    if (sql.includes("FROM pr_ai_reviews")) return { rows: [] };
    if (sql.includes("INSERT INTO pr_ai_reviews")) return { rows: [{ id: "new-review" }] };
    if (sql.includes("INSERT INTO jobs")) return { rows: [{ id: "job-new" }], rowCount: 1 };
    throw new Error(`unexpected transaction query: ${sql}`);
  }) };
  const res = response();

  await adminApi(request({ action: "ai-review", ids: [bad.id, good.id] }), res, new URL(bulkUrl), { user_id: "admin" });

  expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  const body = jsonOf(res);
  expect(body.results.find((r: any) => r.id === bad.id)).toMatchObject({ outcome: "skipped" });
  expect(body.results.find((r: any) => r.id === good.id)).toMatchObject({ outcome: "queued" });
});

test("bulk close skips a non-open PR and queues an open one, enqueuing github.close_pull_request", async () => {
  const openPr = { ...basePr, id: uuid(7), number: 7, title: "Open" };
  const mergedPr = { ...basePr, id: uuid(8), number: 8, title: "Merged", state: "merged" };
  const jobInserts: any[] = [];
  pool.query.mockImplementation(async (sql: string, values?: any[]) => {
    if (sql.includes("SELECT pr.*,p.github_owner,p.github_repository")) {
      const ids: string[] = values![0];
      return { rows: [openPr, mergedPr].filter((row) => ids.includes(row.id)) };
    }
    if (sql.includes("INSERT INTO jobs")) { jobInserts.push(values); return { rows: [{ id: "job-close" }], rowCount: 1 }; }
    if (sql.includes("INSERT INTO audit_events")) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected query: ${sql}`);
  });
  const res = response();

  await adminApi(request({ action: "close", ids: [openPr.id, mergedPr.id] }), res, new URL(bulkUrl), { user_id: "admin" });

  expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  const body = jsonOf(res);
  expect(body.results).toEqual(expect.arrayContaining([
    { id: openPr.id, outcome: "queued", job_id: "job-close" },
    { id: mergedPr.id, outcome: "skipped", reason: "pull request is merged, not open" },
  ]));
  expect(jobInserts).toHaveLength(1);
  expect(jobInserts[0][0]).toBe("github.close_pull_request");
});

test("bulk merge re-evaluates eligibility server-side from the freshly-queried row, never from the request body", async () => {
  const pr = { ...basePr, id: uuid(9), number: 9, title: "Mergeable" };
  const jobInserts: any[] = [];
  pool.query.mockImplementation(async (sql: string, values?: any[]) => {
    if (sql.includes("SELECT pr.*,p.github_owner,p.github_repository")) {
      const ids: string[] = values![0];
      return { rows: [pr].filter((row) => ids.includes(row.id)) };
    }
    if (sql.includes("FROM pull_request_merge_settings")) return { rows: [{ require_fresh_policy_binding: true }] };
    if (sql.includes("INSERT INTO jobs")) { jobInserts.push(values); return { rows: [{ id: "job-merge" }], rowCount: 1 }; }
    if (sql.includes("INSERT INTO audit_events")) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected query: ${sql}`);
  });
  const res = response();

  // A malicious/stale expected_head_sha in the body must be ignored entirely — this
  // route never accepts expected_head_sha from the client.
  await adminApi(request({
    action: "merge", ids: [pr.id],
    expected_head_sha: "attacker-supplied-sha",
  }), res, new URL(bulkUrl), { user_id: "admin" });

  expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  expect(jobInserts).toHaveLength(1);
  expect(jobInserts[0][2]).toMatchObject({ expected_head_sha: pr.head_sha });
  expect(jobInserts[0][2].expected_head_sha).not.toBe("attacker-supplied-sha");
});

test("bulk merge skips a draft PR with the correct reason and does not enqueue a job", async () => {
  const draft = { ...basePr, id: uuid(10), number: 10, title: "Draft", is_draft: true };
  const jobInserts: any[] = [];
  pool.query.mockImplementation(async (sql: string, values?: any[]) => {
    if (sql.includes("SELECT pr.*,p.github_owner,p.github_repository")) {
      const ids: string[] = values![0];
      return { rows: [draft].filter((row) => ids.includes(row.id)) };
    }
    if (sql.includes("FROM pull_request_merge_settings")) return { rows: [{ require_fresh_policy_binding: true }] };
    if (sql.includes("INSERT INTO jobs")) { jobInserts.push(values); return { rows: [{ id: "job-merge" }], rowCount: 1 }; }
    if (sql.includes("INSERT INTO audit_events")) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected query: ${sql}`);
  });
  const res = response();

  await adminApi(request({ action: "merge", ids: [draft.id] }), res, new URL(bulkUrl), { user_id: "admin" });

  const body = jsonOf(res);
  expect(body.results).toEqual([{ id: draft.id, outcome: "skipped", reason: expect.stringMatching(/draft/i) }]);
  expect(jobInserts).toHaveLength(0);
});

test("bulk merge skips a PR with merge conflicts with the correct reason and does not enqueue a job", async () => {
  const conflicted = { ...basePr, id: uuid(11), number: 11, title: "Conflicted", merge_conflicts: true };
  const jobInserts: any[] = [];
  pool.query.mockImplementation(async (sql: string, values?: any[]) => {
    if (sql.includes("SELECT pr.*,p.github_owner,p.github_repository")) {
      const ids: string[] = values![0];
      return { rows: [conflicted].filter((row) => ids.includes(row.id)) };
    }
    if (sql.includes("FROM pull_request_merge_settings")) return { rows: [{ require_fresh_policy_binding: true }] };
    if (sql.includes("INSERT INTO jobs")) { jobInserts.push(values); return { rows: [{ id: "job-merge" }], rowCount: 1 }; }
    if (sql.includes("INSERT INTO audit_events")) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected query: ${sql}`);
  });
  const res = response();

  await adminApi(request({ action: "merge", ids: [conflicted.id] }), res, new URL(bulkUrl), { user_id: "admin" });

  const body = jsonOf(res);
  expect(body.results).toEqual([{ id: conflicted.id, outcome: "skipped", reason: expect.stringMatching(/conflict/i) }]);
  expect(jobInserts).toHaveLength(0);
});

test("an id that doesn't exist in pull_requests is reported not_found, not a 500", async () => {
  const missing = uuid(12);
  pool.query.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT pr.*,p.github_owner,p.github_repository")) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  });
  const res = response();

  await adminApi(request({ action: "close", ids: [missing] }), res, new URL(bulkUrl), { user_id: "admin" });

  expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  const body = jsonOf(res);
  expect(body.results).toEqual([{ id: missing, outcome: "not_found" }]);
});

test("more than 100 ids is rejected with 400 before any query runs", async () => {
  const ids = Array.from({ length: 101 }, (_, i) => uuid(1000 + i));
  const res = response();

  await adminApi(request({ action: "close", ids }), res, new URL(bulkUrl), { user_id: "admin" });

  expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  expect(pool.query).not.toHaveBeenCalled();
});

test("every successful action writes an audit_events row tagged with the same batch_id", async () => {
  const openPr = { ...basePr, id: uuid(13), number: 13, title: "Open" };
  const auditRows: any[] = [];
  const jobInserts: any[] = [];
  pool.query.mockImplementation(async (sql: string, values?: any[]) => {
    if (sql.includes("SELECT pr.*,p.github_owner,p.github_repository")) {
      const ids: string[] = values![0];
      return { rows: [openPr].filter((row) => ids.includes(row.id)) };
    }
    if (sql.includes("INSERT INTO jobs")) { jobInserts.push(values); return { rows: [{ id: "job-close" }], rowCount: 1 }; }
    if (sql.includes("INSERT INTO audit_events")) { auditRows.push(values); return { rows: [], rowCount: 1 }; }
    throw new Error(`unexpected query: ${sql}`);
  });
  const res = response();

  await adminApi(request({ action: "close", ids: [openPr.id], batch_id: "batch-42" }), res, new URL(bulkUrl), { user_id: "admin" });

  const body = jsonOf(res);
  expect(body.batch_id).toBe("batch-42");
  expect(auditRows).toHaveLength(1);
  expect(auditRows[0][7]).toMatchObject({ batch_id: "batch-42" });
});

test("a failing audit insert does not duplicate or downgrade the result entry for a PR that was queued", async () => {
  const openPr = { ...basePr, id: uuid(14), number: 14, title: "Open" };
  const other = { ...basePr, id: uuid(15), number: 15, title: "Also open" };
  const jobInserts: any[] = [];
  pool.query.mockImplementation(async (sql: string, values?: any[]) => {
    if (sql.includes("SELECT pr.*,p.github_owner,p.github_repository")) {
      const ids: string[] = values![0];
      return { rows: [openPr, other].filter((row) => ids.includes(row.id)) };
    }
    if (sql.includes("INSERT INTO jobs")) { jobInserts.push(values); return { rows: [{ id: `job-${jobInserts.length}` }], rowCount: 1 }; }
    if (sql.includes("INSERT INTO audit_events")) throw new Error("simulated audit insert failure (e.g. FK violation, transient connection error)");
    throw new Error(`unexpected query: ${sql}`);
  });
  const res = response();

  await adminApi(request({ action: "close", ids: [openPr.id, other.id] }), res, new URL(bulkUrl), { user_id: "admin" });

  // Both close jobs were really enqueued, so both must be reported exactly once as queued —
  // the audit failure must not push a second, contradictory "skipped" entry for the same id.
  expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  expect(jobInserts).toHaveLength(2);
  const body = jsonOf(res);
  expect(body.results).toEqual([
    { id: openPr.id, outcome: "queued", job_id: "job-1" },
    { id: other.id, outcome: "queued", job_id: "job-2" },
  ]);
});
