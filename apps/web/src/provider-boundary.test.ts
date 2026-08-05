import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("web provider routes only persist or enqueue provider work", async () => {
  const source = await readFile(new URL("./server.ts", import.meta.url), "utf8");
  const ui = await readFile(new URL("./ui.ts", import.meta.url), "utf8");
  for (const directCall of ["approveAndMergePullRequest", "syncOpenPullRequests", "syncPullRequest", "importGithubPullRequests", "createNotificationProvider", "redactNotificationError"]) {
    expect(source).not.toContain(directCall);
  }
  expect(source).not.toMatch(/\bmergeBranch\s*\(/);
  for (const type of ["github.sync_open", "github.sync_one", "github.import", "github.merge_pull_request", "github.merge_branches"]) {
    expect(source).toContain(type);
  }
  expect(source).toContain("parseNotificationConfiguration");
  expect(source).toContain("parseNotificationConfigurationPatch");
  expect(source).toContain("mergeNotificationConfiguration");
  expect(source).toContain("safeNotificationProvider");
  expect(source).toContain("providers: providers.map(safeNotificationProvider)");
  expect(source).toContain("after: safeNotificationProvider(result.rows[0])");
  expect(source).toContain("before: safeNotificationProvider(before), after: safeNotificationProvider(after)");
  expect(source).toContain("provider: safeNotificationProvider(after)");
  expect(source).toContain("retryNotificationDelivery");
  expect(ui).toContain('authentication:authType==="none"?(providerId?null:undefined)');
});
