// SEC-17 [HARD-FAIL]: across the full eval run, the app must never issue a
// real PUT .../pulls/{number}/merge request — mock-github's real /merge
// route ALWAYS responds 403 by design (see harness/mock-github/README.md:
// "PUT /merge always 403 ... to catch code that tries to auto-merge"), and
// merges must instead be simulated externally via POST
// /_control/.../merge (PRD §21.3: "The application must never call a merge
// operation automatically. A merge performed externally on GitHub is
// detected and synchronized back into the platform.").
//
// This test reads MOCK_GITHUB_LOG (a single shared append-only file for the
// whole eval run, per HARNESS_CONVENTIONS.md) rather than driving any
// PR/merge flow itself, so it's meaningful only once other tests have
// exercised the PR lifecycle. score.sh runs harness/tests/api/*.spec.ts
// before harness/tests/probes/*.spec.ts, and this file is the
// alphabetically-last probe, so by the time it runs, any PR-lifecycle
// activity from earlier spec files has already been logged. If the log is
// empty or has no PR/merge activity yet (e.g. this batch of tests alone
// never creates a PR), that is a VACUOUS PASS, not a failure — there is
// nothing to have violated yet.

import { describe, it, expect } from "vitest";
import { readMockGithubLog } from "../helpers";

const MERGE_PATH_RE = /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/merge$/;

describe("mock-github request log", () => {
  it("app never calls the real merge endpoint", () => {
    const log = readMockGithubLog();

    if (log.length === 0) {
      console.warn("mock-github-log: log is empty — vacuous pass, no PR/merge activity has happened yet.");
    }

    const realMergeCalls = log.filter((entry) => entry.method === "PUT" && MERGE_PATH_RE.test(entry.path ?? ""));

    expect(
      realMergeCalls,
      `found real PUT .../merge call(s) — merges must only happen via /_control/ simulation (external, on GitHub):\n${JSON.stringify(realMergeCalls, null, 2)}`,
    ).toHaveLength(0);
  });
});
