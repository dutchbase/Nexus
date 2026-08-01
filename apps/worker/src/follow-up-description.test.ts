import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { formatFollowUpDescription } from "./follow-up-description.ts";

describe("formatFollowUpDescription", () => {
  it("adds the PR source first and keeps the complete description within 12000 characters", () => {
    const description = formatFollowUpDescription(
      { number: 42, title: "Repair login flow", url: "https://github.com/acme/widgets/pull/42" },
      "x".repeat(12_100),
    );

    expect(description.startsWith("## Source\n\n- Pull request: [PR #42: Repair login flow](https://github.com/acme/widgets/pull/42)\n\n")).toBe(true);
    expect(description).toHaveLength(12_000);
  });
});

it("casts the JSON key when saving generated output", async () => {
  const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
  expect(worker).toContain("jsonb_build_object($2::text,$3::text)");
});

it("upserts on project_id+number instead of a plain insert, so it can't collide with the PR sync job", async () => {
  const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
  expect(worker).toContain("ON CONFLICT (project_id,number) DO UPDATE SET");
});

it("only claims ticket_id/execution_attempt_id when the existing row is unowned, so it can't steal ownership from another attempt", async () => {
  const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
  expect(worker).toContain("ticket_id=COALESCE(pull_requests.ticket_id, EXCLUDED.ticket_id)");
  expect(worker).toContain("execution_attempt_id=COALESCE(pull_requests.execution_attempt_id, EXCLUDED.execution_attempt_id)");
});

it("looks up an existing pull_requests row by branch too, not just execution_attempt_id", async () => {
  const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
  expect(worker).toContain("OR (project_id=$2 AND head_branch=$3)");
});

it("orders the branch-widened lookup so the attempt's own row always wins over an unrelated same-branch row", async () => {
  const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
  expect(worker).toContain("ORDER BY (execution_attempt_id IS NOT DISTINCT FROM $1) DESC, created_at_provider DESC");
});

it("claims ticket_id/execution_attempt_id on a found row left NULL by the sync job, before falling into the insert-only path", async () => {
  const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
  expect(worker).toContain("if (stored && (!stored.ticket_id || !stored.execution_attempt_id)) {");
  expect(worker).toContain(
    "SET ticket_id=COALESCE(ticket_id,$2),\n               execution_attempt_id=COALESCE(execution_attempt_id,$3),",
  );
});

describe("scripts/remediate-pr-creation-failed.ts", () => {
  it("only claims ownership when the pull_requests row is currently unowned", async () => {
    const script = await readFile(
      new URL("../../../scripts/remediate-pr-creation-failed.ts", import.meta.url),
      "utf8",
    );
    expect(script).toContain(
      "SET execution_attempt_id=COALESCE(execution_attempt_id,$1), ticket_id=COALESCE(ticket_id,$2)",
    );
  });

  it("only re-remediates attempts whose ticket is still stuck at PR Creation Failed", async () => {
    const script = await readFile(
      new URL("../../../scripts/remediate-pr-creation-failed.ts", import.meta.url),
      "utf8",
    );
    expect(script).toContain("AND t.status = 'PR Creation Failed'");
  });

  it("picks a deterministic PR when multiple rows share the same branch", async () => {
    const script = await readFile(
      new URL("../../../scripts/remediate-pr-creation-failed.ts", import.meta.url),
      "utf8",
    );
    expect(script).toContain("ORDER BY (state='open') DESC, created_at_provider DESC LIMIT 1");
  });
});
