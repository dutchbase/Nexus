import { expect, it } from "vitest";
import { persistConflictResolutionSuccess } from "./conflict-resolution-success.ts";

type State = {
  run: { status: string; workingDirectory: string | null; exitCode: number | null };
  resolution: { status: string; summary: string | null; resolvedSha: string | null };
  artifacts: Array<{ storagePath: string; sha256: string; runId: string }>;
};

function initialState(): State {
  return {
    run: { status: "running", workingDirectory: "/data/worktrees/acme/pr-1", exitCode: null },
    resolution: { status: "running", summary: null, resolvedSha: null },
    artifacts: [],
  };
}

function transactionFor(state: State, failArtifact = false) {
  return async (work: (client: { query: (sql: string, values: unknown[]) => Promise<unknown> }) => Promise<void>) => {
    const next = structuredClone(state);
    await work({
      query: async (sql, values) => {
        if (sql.includes("UPDATE agent_runs")) {
          next.run = { status: "completed", workingDirectory: null, exitCode: values[1] as number };
        } else if (sql.includes("UPDATE pr_conflict_resolutions")) {
          next.resolution = {
            status: "resolved",
            summary: values[1] as string,
            resolvedSha: values[2] as string,
          };
        } else if (sql.includes("INSERT INTO artifacts")) {
          if (failArtifact) throw new Error("artifact insert failed");
          next.artifacts.push({
            storagePath: values[1] as string,
            sha256: values[2] as string,
            runId: values[3] as string,
          });
        }
        return {};
      },
    });
    Object.assign(state, next);
  };
}

const input = {
  runId: "run-1",
  resolutionId: "resolution-1",
  summary: "Resolved conflicts",
  resolvedCommit: "post-merge-commit",
  storagePath: "worktrees/acme/pr-1-conflict-resolution",
  exitCode: 0,
};

it("atomically completes the run and resolution with the retained worktree", async () => {
  const state = initialState();

  await persistConflictResolutionSuccess(input, transactionFor(state));

  expect(state).toEqual({
    run: { status: "completed", workingDirectory: null, exitCode: 0 },
    resolution: {
      status: "resolved",
      summary: "Resolved conflicts",
      resolvedSha: "post-merge-commit",
    },
    artifacts: [{
      storagePath: "worktrees/acme/pr-1-conflict-resolution",
      sha256: "7bfdf5b7a89b7cee5e18f7e1d3ebc5ca8fd3e31b29efbbbf72f07e2487fcf6f9",
      runId: "run-1",
    }],
  });
});

it("does not retain local success state when artifact registration fails", async () => {
  const state = initialState();

  await expect(persistConflictResolutionSuccess(input, transactionFor(state, true)))
    .rejects.toThrow("artifact insert failed");
  expect(state).toEqual(initialState());
});
