import { createServer } from "node:http";
import { afterEach, expect, test } from "vitest";
import { approveAndMergePullRequest, PullRequestMergeError } from "./pr-merge.ts";

const originalApiBaseUrl = process.env.GITHUB_API_BASE_URL;
const originalToken = process.env.GITHUB_TOKEN;

afterEach(() => {
  if (originalApiBaseUrl === undefined) delete process.env.GITHUB_API_BASE_URL;
  else process.env.GITHUB_API_BASE_URL = originalApiBaseUrl;
  if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalToken;
});

test("does not approve a review when GitHub rejects its changed reviewed head", async () => {
  let body: Record<string, unknown> | undefined;
  let databaseWrites = 0;
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    body = JSON.parse(Buffer.concat(chunks).toString());
    outgoing.statusCode = 409;
    outgoing.end("head changed");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP port");
    process.env.GITHUB_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.GITHUB_TOKEN = "test-token";

    await expect(approveAndMergePullRequest(
      { query: async () => { databaseWrites++; return { rows: [] }; } } as any,
      { id: "pr-id", repository: "acme/widgets", number: 42, base_branch: "main", is_draft: false },
      undefined,
      { type: "worker", id: "review-id" },
      "reviewed-sha",
    )).rejects.toBeInstanceOf(PullRequestMergeError);

    expect(body).toEqual({ merge_method: "squash", sha: "reviewed-sha" });
    expect(databaseWrites).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("does not merge when the PR base branch or commit changed after AI review", async () => {
  let mergeRequests = 0;
  const server = createServer((incoming, outgoing) => {
    if (incoming.method === "GET") {
      outgoing.setHeader("content-type", "application/json");
      outgoing.end(JSON.stringify({ base: { ref: "main", sha: "advanced-base-sha" } }));
      return;
    }
    mergeRequests++;
    outgoing.setHeader("content-type", "application/json");
    outgoing.end(JSON.stringify({ merged: true, sha: "merged", message: "merged" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP port");
    process.env.GITHUB_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.GITHUB_TOKEN = "test-token";

    await expect(approveAndMergePullRequest(
      { query: async () => ({ rows: [] }) } as any,
      { id: "pr-id", repository: "acme/widgets", number: 42, base_branch: "main", is_draft: false },
      undefined,
      { type: "worker", id: "review-id" },
      "reviewed-sha",
      "main",
      "reviewed-base-sha",
    )).rejects.toThrow("base changed");
    expect(mergeRequests).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
