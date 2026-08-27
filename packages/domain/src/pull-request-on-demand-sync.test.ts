import { beforeEach, expect, test, vi } from "vitest";

const github = vi.hoisted(() => ({
  getPullRequestPolicyInputs: vi.fn(),
}));

vi.mock("../../github-provider/src/index.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../github-provider/src/index.ts")>(),
  ...github,
}));

const { ensurePolicySnapshot } = await import("./pull-request-on-demand-sync.ts");
const { GitHubProviderError } = await import("../../github-provider/src/index.ts");

function policy(overrides: Record<string, unknown> = {}) {
  return {
    pullRequest: {
      number: 42, html_url: "https://github.test/acme/widgets/pull/42", state: "open", draft: false,
      title: "Ready", head: { ref: "feature", sha: "head-sha" }, base: { ref: "main", sha: "base-sha" },
      created_at: "2026-08-04T10:00:00Z", updated_at: "2026-08-04T10:00:00Z",
    },
    protected: false,
    requiredApprovals: 0,
    reviews: [],
    requestedReviewers: [],
    requiredChecks: [],
    checks: [],
    complete: true,
    fetchedAt: "2026-08-04T10:01:00Z",
    ...overrides,
  } as any;
}

function database() {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    queries.push({ sql, values });
    if (sql.includes("INSERT INTO pull_request_policy_snapshots")) {
      return { rows: [{ id: "snapshot-1", material_hash: "hash-1" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const client = { query, release: vi.fn() };
  return { query, connect: vi.fn(async () => client), queries } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

test("persists a snapshot and returns synced outcome when GitHub call succeeds", async () => {
  const db = database();
  github.getPullRequestPolicyInputs.mockResolvedValue(policy());

  const result = await ensurePolicySnapshot(db, { pullRequestId: "pr-1", owner: "o", repo: "r", number: 1 });

  expect(result).toEqual({ outcome: "synced", snapshotId: "snapshot-1" });
  expect(github.getPullRequestPolicyInputs).toHaveBeenCalledWith("o", "r", 1);
  expect(db.queries.some(({ sql }: { sql: string }) => sql.includes("INSERT INTO pull_request_policy_snapshots"))).toBe(true);
  expect(db.queries.some(({ sql, values }: any) => sql.includes("UPDATE pull_requests") && sql.includes("current_policy_snapshot_id")
    && values?.includes("snapshot-1"))).toBe(true);
});

test("writes the snapshot and its pull_requests binding in one transaction", async () => {
  const db = database();
  github.getPullRequestPolicyInputs.mockResolvedValue(policy());

  await ensurePolicySnapshot(db, { pullRequestId: "pr-1", owner: "o", repo: "r", number: 1 });

  const statements = db.queries.map(({ sql }: { sql: string }) => sql.trim().split(/\s+/).slice(0, 3).join(" "));
  expect(statements[0]).toBe("BEGIN");
  expect(statements.at(-1)).toBe("COMMIT");
  expect(statements.filter((sql: string) => sql.startsWith("INSERT INTO pull_request_policy_snapshots"))).toHaveLength(1);
});

test("returns error outcome without writing a snapshot when GitHub call throws GitHubProviderError", async () => {
  const db = database();
  github.getPullRequestPolicyInputs.mockRejectedValue(new GitHubProviderError("rate_limited", "rate limited", 429));

  const result = await ensurePolicySnapshot(db, { pullRequestId: "pr-1", owner: "o", repo: "r", number: 1 });

  expect(result).toEqual({ outcome: "error", errorCode: "rate_limited", retryAfter: null });
  expect(db.queries.some(({ sql }: { sql: string }) => sql.includes("INSERT INTO pull_request_policy_snapshots"))).toBe(false);
  expect(db.queries.some(({ sql, values }: any) => sql.includes("UPDATE pull_requests") && sql.includes("policy_error_code")
    && values?.includes("rate_limited"))).toBe(true);
});
