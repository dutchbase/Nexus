import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

let publish = "";
let runExecution = "";

beforeAll(async () => {
  const worker = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
  runExecution = worker.slice(worker.indexOf("async function runExecution"), worker.indexOf("async function publishExecutionAttempt"));
  publish = worker.slice(worker.indexOf("async function publishExecutionAttempt"), worker.indexOf("async function retryPublication"));
});

describe("publishExecutionAttempt persistence", () => {
  it("records the validated commit and pending publication intent before provider calls", () => {
    const providerCall = publish.indexOf("await pushExecutionBranch");
    const intent = publish.indexOf("INSERT INTO execution_publications");
    const beforeProvider = publish.slice(0, providerCall);

    expect(intent).toBeGreaterThan(0);
    expect(intent).toBeLessThan(providerCall);
    expect(beforeProvider).toContain("UPDATE execution_attempts SET result_commit=$2,validation_status='validated'");
    expect(beforeProvider).toContain("'execution.commit'");
    expect(beforeProvider).toContain("'pending'");
  });

  it("marks the intent publishing and audits the request before provider calls", () => {
    const providerCall = publish.indexOf("await pushExecutionBranch");
    const beforeProvider = publish.slice(0, providerCall);

    expect(beforeProvider).toContain("SET status='publishing',attempt_count=attempt_count + 1,last_job_id=$2");
    expect(beforeProvider).toContain("'execution.publication.requested'");
  });

  it("reconciles duplicates and completes publication in one final transaction", () => {
    const reconcile = publish.indexOf("await findOpenPullRequestForHead");
    const create = publish.indexOf("await createPullRequest");
    const completion = publish.indexOf("await inTransaction(async (client) => {", create);
    const transaction = publish.slice(completion, publish.indexOf("  } catch (error)"));

    expect(reconcile).toBeGreaterThan(0);
    expect(reconcile).toBeLessThan(create);
    expect(completion).toBeGreaterThan(create);
    expect(transaction).toContain("INSERT INTO pull_requests");
    expect(transaction).toContain("INSERT INTO artifacts");
    expect(transaction).toContain("UPDATE tickets SET status='PR Ready for Review'");
    expect(transaction).toContain("UPDATE execution_attempts SET validation_status='completed'");
    expect(transaction).toContain("UPDATE execution_publications");
    expect(transaction).toContain("status='published'");
    expect(transaction).toContain("'execution.publication.published'");
    expect(transaction).toContain("false, providerPr.head.ref, providerPr.base.ref, commit,");
  });

  it("preserves a failed publication and bypasses the generic execution failure rewrite", () => {
    const failure = publish.slice(publish.indexOf("  } catch (error)"));
    const executionCatch = runExecution.slice(runExecution.lastIndexOf("  } catch (error)"));

    expect(failure).toContain("UPDATE execution_publications");
    expect(failure).toContain("status='failed'");
    expect(failure).toContain('"PR Creation Failed"');
    expect(failure).toContain("'execution.publication.failed'");
    expect(failure).toContain("throw new PublicationError");
    expect(executionCatch).toContain("if (error instanceof PublicationError) throw error;");
  });
});
