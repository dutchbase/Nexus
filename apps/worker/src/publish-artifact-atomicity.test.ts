import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("publishExecutionAttempt persistence", () => {
  it("registers the local PR and worktree in the same completion transaction", async () => {
    const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
    const publish = worker.slice(worker.indexOf("async function publishExecutionAttempt"));
    const transaction = publish.slice(
      publish.indexOf("await inTransaction(async (client) => {"),
      publish.indexOf("  } catch (error)"),
    );

    expect(transaction).toContain("INSERT INTO pull_requests");
    expect(transaction).toContain("INSERT INTO artifacts");
    expect(transaction).toContain("UPDATE tickets SET status='PR Ready for Review'");
    expect(transaction).toContain("UPDATE execution_attempts SET validation_status='completed'");
  });

  it("persists the provider base ref for a discovered non-default target branch", async () => {
    const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
    expect(worker).toContain("providerPr.draft, providerPr.head.ref, providerPr.base.ref, commit,");
    expect(worker).not.toContain("providerPr.draft, providerPr.head.ref, input.project.default_branch, commit,");
  });
});
