import { expect, test, vi } from "vitest";

import {
  failExecutionPublication,
  handleExecutionPublicationFailure,
  prepareExecutionPublication,
  PublicationError,
  publishExternalResult,
} from "./execution-publication.ts";

function publicationClient(initialStatus: "pending" | "publishing" | "published" | "failed") {
  let status = initialStatus;
  const history: string[] = [];
  const audits: string[] = [];
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM execution_publications ep")) return { rows: [{
      id: "publication-1", status, last_job_id: "job-1", ticket_id: "ticket-1", agent_run_id: "run-1",
      plan_version_id: "plan-1",
    }], rowCount: 1 };
    if (sql.includes("UPDATE execution_publications")) {
      if (!["pending", "publishing"].includes(status)) return { rows: [], rowCount: 0 };
      status = "failed";
      return { rows: [{ id: "publication-1" }], rowCount: 1 };
    }
    if (sql.includes("SELECT status FROM tickets")) return { rows: [{ status: "Validating" }], rowCount: 1 };
    if (sql.includes("INSERT INTO ticket_status_history")) history.push("PR Creation Failed");
    if (sql.includes("'execution.publication.failed'")) audits.push("failed");
    return { rows: [], rowCount: 1 };
  });
  return { client: { query }, get status() { return status; }, set status(value) { status = value; }, history, audits };
}

const failure = {
  attemptId: "attempt-1", jobId: "job-1", errorMessage: "provider unavailable",
  reason: "Worker-controlled push or pull-request creation failed: provider unavailable",
};

test("provider failure records one retryable publication transition", async () => {
  const state = publicationClient("publishing");

  await expect(publishExternalResult({
    push: async () => undefined,
    find: async () => { throw new Error("provider unavailable"); },
    create: async () => ({ number: 7 }),
    complete: async () => undefined,
    fail: (error) => failExecutionPublication(state.client, { ...failure, errorMessage: error.message }),
  })).rejects.toBeInstanceOf(PublicationError);

  expect(state.status).toBe("failed");
  expect(state.history).toEqual(["PR Creation Failed"]);
  expect(state.audits).toEqual(["failed"]);
});

test.each(["commit/effective validation", "publication intent insert"])("%s failure stays generic when no publication intent exists", async () => {
  const failure = new Error("pre-intent failure");
  const fail = vi.fn(async () => "missing" as const);

  await expect(handleExecutionPublicationFailure(failure, fail)).rejects.toBe(failure);
  expect(fail).toHaveBeenCalledWith(failure);
});

test("an older published attempt is reopened for repaired publication", async () => {
  const publication: {
    id: string; status: string; last_job_id: string | null; idempotency_key: string;
    pull_request_id: string; published_at: string | null;
  } = {
    id: "publication-1", status: "published", last_job_id: "job-1",
    idempotency_key: "execution-publication:attempt-1", pull_request_id: "pr-1",
    published_at: "2026-08-03T10:00:00.000Z",
  };
  let resultCommit = "old-commit";
  let committed = false;
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("INSERT INTO execution_publications")) return { rows: [{ ...publication }], rowCount: 1 };
    if (sql.includes("UPDATE execution_attempts")) {
      resultCommit = values?.[1] as string;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("'execution.commit'")) {
      committed = true;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE execution_publications")) {
      publication.status = "pending";
      publication.last_job_id = null;
      publication.published_at = null;
      return { rows: [{ ...publication }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });

  const prepared = await prepareExecutionPublication({ query }, {
    attemptId: "attempt-1", jobId: "job-2", commit: "repaired-commit", committedNow: true,
  });

  expect(prepared).toMatchObject({
    status: "pending", last_job_id: null,
    idempotency_key: "execution-publication:attempt-1", pull_request_id: "pr-1", published_at: null,
  });
  expect(resultCommit).toBe("repaired-commit");
  expect(committed).toBe(true);
});

test("a same-job published replay is already complete", async () => {
  const publication = {
    id: "publication-1", status: "published", last_job_id: "job-2",
    idempotency_key: "execution-publication:attempt-1", pull_request_id: "pr-1",
  };
  const query = vi.fn(async () => ({ rows: [{ ...publication }], rowCount: 1 }));

  await expect(prepareExecutionPublication({ query }, {
    attemptId: "attempt-1", jobId: "job-2", commit: "repaired-commit", committedNow: true,
  })).resolves.toEqual(publication);

  expect(query).toHaveBeenCalledTimes(1);
});

test("a pre-transition failure against another job's publication stays generic", async () => {
  const failure = new Error("repair validation crashed");
  const fail = vi.fn(async () => "published_by_other_job" as const);

  await expect(handleExecutionPublicationFailure(failure, fail)).rejects.toBe(failure);
});

test("duplicate reconciliation completes the discovered pull request without creating another", async () => {
  const create = vi.fn(async () => ({ number: 8 }));
  let completed = 0;

  await publishExternalResult({
    push: async () => undefined,
    find: async () => ({ number: 7 }),
    create,
    complete: async (pullRequest) => { completed = pullRequest.number; },
    fail: async () => "failed",
  });

  expect(create).not.toHaveBeenCalled();
  expect(completed).toBe(7);
});

test("ambiguous completion commit preserves published state without failure history or audit", async () => {
  const state = publicationClient("publishing");

  await expect(publishExternalResult({
    push: async () => undefined,
    find: async () => ({ number: 7 }),
    create: async () => ({ number: 8 }),
    complete: async () => {
      state.status = "published";
      throw new Error("connection closed after commit");
    },
    fail: (error) => failExecutionPublication(state.client, { ...failure, errorMessage: error.message }),
  })).resolves.toBeUndefined();

  expect(state.status).toBe("published");
  expect(state.history).toEqual([]);
  expect(state.audits).toEqual([]);
});

test("repeated failure reconciliation does not duplicate history or audit", async () => {
  const state = publicationClient("publishing");

  await expect(failExecutionPublication(state.client, failure)).resolves.toBe("failed");
  await expect(failExecutionPublication(state.client, failure)).resolves.toBe("failed");

  expect(state.status).toBe("failed");
  expect(state.history).toEqual(["PR Creation Failed"]);
  expect(state.audits).toEqual(["failed"]);
});
