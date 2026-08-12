import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";

// Covers two Task B4 fix-round-1 issues:
//
// (1) follow-up-description jobs must be claimable without going through
//     subscriptionPreflightOrRefuse() once the API transport is active for
//     them — otherwise a queued follow-up job stalls forever (preflight can
//     never succeed while Claude CLI auth is broken, even though this job
//     type no longer needs it) and the "anything Claude-dependent queued?"
//     probe spins re-checking auth every loop iteration for nothing.
// (2) a typo'd DCC_ANTHROPIC_API_JOBS entry must crash the worker loudly at
//     startup, not be silently absorbed by refuseQueuedClaudeJobs' bare
//     try/catch (which exists only to tolerate the database being
//     unreachable).
//
// worker.ts's claim loop is top-level script code, not an exported
// function, so it can't be unit-tested by importing worker.ts directly (it
// would run the whole process). Following the established pattern in this
// suite (apps/worker/src/task-6.test.ts, apps/worker/src/task-7.test.ts) for
// this kind of unexported main-loop logic, the claim-loop shape is verified
// by reading worker.ts's own source; the startup-crash behavior is verified
// behaviorally by spawning worker.ts as a subprocess, the same way
// apps/worker/src/role.test.ts proves the DCC_PROCESS_ROLE fail-closed check.

const root = resolve(import.meta.dirname, "../../..");
const worker = () => readFile(new URL("./worker.ts", import.meta.url), "utf8");

test("follow-up-description job types are excluded from the Claude-dependent claim/probe set that gates on subscriptionPreflightOrRefuse() when the API transport is active", async () => {
  const source = await worker();

  // followUpUsesAnthropicApi must be resolved once, before the loop, and
  // reused (not re-evaluated with a stray usesAnthropicApi(...) call) at
  // both claim sites.
  expect(source).toContain('const followUpUsesAnthropicApi = usesAnthropicApi("pr_follow_up_description");');

  const loopStart = source.indexOf("let job = await claimJob(workerId,");
  expect(loopStart).toBeGreaterThan(-1);
  const loopSection = source.slice(loopStart, source.indexOf("await pool.end();"));

  // The first (ungated) claimJob call must be able to pick up
  // follow-up-description jobs once the API transport is active for them.
  const ungatedClaimEnd = loopSection.indexOf("if (!job) {");
  const ungatedClaim = loopSection.slice(0, ungatedClaimEnd);
  expect(ungatedClaim).toContain("...(followUpUsesAnthropicApi ? followUpDescriptionJobTypes : [])");

  // The gated set (used for both the "anything queued?" probe and the
  // second claimJob call behind subscriptionPreflightOrRefuse()) must drop
  // follow-up-description jobs once the API transport is active for them,
  // and both call sites must share one definition so they can't drift.
  const gatedSection = loopSection.slice(ungatedClaimEnd);
  expect(gatedSection).toContain("const claudeDependentJobTypes = [");
  expect(gatedSection).toContain("...(followUpUsesAnthropicApi ? [] : followUpDescriptionJobTypes)");
  const probeCount = (gatedSection.match(/claudeDependentJobTypes/g) ?? []).length;
  // Declaration + SQL probe param + gated claimJob call = 3 references.
  expect(probeCount).toBeGreaterThanOrEqual(3);
});

test("DCC_ANTHROPIC_API_JOBS is resolved outside the database-unavailability try/catch in refuseQueuedClaudeJobs", async () => {
  const source = await worker();

  const fnStart = source.indexOf("async function refuseQueuedClaudeJobs");
  const fnEnd = source.indexOf("\n}\n", fnStart);
  const fnBody = source.slice(fnStart, fnEnd);

  // The resilience catch must still be present and still empty/tolerant...
  expect(fnBody).toContain("} catch {");
  expect(fnBody).toContain("Startup refusal must remain visible even when the database is unavailable");
  // ...but must no longer itself call usesAnthropicApi() — that call (and
  // its potential throw on a config typo) must have already happened
  // earlier, outside this try.
  expect(fnBody).not.toContain("usesAnthropicApi(");
  expect(fnBody).toContain("followUpUsesAnthropicApi");

  // The shared const must be declared before refuseQueuedClaudeJobs is
  // defined (i.e. at true module-load time), not inside it.
  const constIndex = source.indexOf("const followUpUsesAnthropicApi = usesAnthropicApi(");
  expect(constIndex).toBeGreaterThan(-1);
  expect(constIndex).toBeLessThan(fnStart);
});

test("a typo'd DCC_ANTHROPIC_API_JOBS phase crashes worker startup loudly instead of being silently swallowed", () => {
  const result = spawnSync("pnpm", ["exec", "tsx", "apps/worker/src/worker.ts"], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      DCC_PROCESS_ROLE: "worker",
      // usesAnthropicApi() short-circuits on `Boolean(ANTHROPIC_API_KEY) &&
      // ...` — anthropicApiPhases() (and its validation) only runs when a
      // key is configured, so a key must be present for this scenario.
      ANTHROPIC_API_KEY: "sk-test-key",
      // Missing underscore — not a recognized AiInvocationPhase.
      DCC_ANTHROPIC_API_JOBS: "pr_followup_description",
    },
  });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('DCC_ANTHROPIC_API_JOBS names unknown phase "pr_followup_description"');
});
