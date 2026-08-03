import { createServer } from "node:http";
import { afterEach, expect, test } from "vitest";
import { createPullRequest, createPullRequestComment, mergePullRequest } from "./index.ts";

const originalApiBaseUrl = process.env.GITHUB_API_BASE_URL;
const originalToken = process.env.GITHUB_TOKEN;

afterEach(() => {
  if (originalApiBaseUrl === undefined) delete process.env.GITHUB_API_BASE_URL;
  else process.env.GITHUB_API_BASE_URL = originalApiBaseUrl;
  if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalToken;
});

test("posts the complete Markdown review as a pull-request comment", async () => {
  let request: { method?: string; url?: string; authorization?: string; body?: string } = {};
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    request = {
      method: incoming.method,
      url: incoming.url,
      authorization: incoming.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()).body,
    };
    outgoing.setHeader("content-type", "application/json");
    outgoing.end(JSON.stringify({ id: 1, html_url: "https://github.com/acme/widgets/issues/42#issuecomment-1" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP port");
    process.env.GITHUB_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.GITHUB_TOKEN = "test-token";

    const markdown = "## Findings\n\n- **Important:** Missing null check.\n\n```json\n{\"verdict\":\"rejected\",\"summary\":\"Null input crashes.\"}\n```";
    await expect(createPullRequestComment("acme", "widgets", 42, markdown)).resolves.toMatchObject({ id: 1 });

    expect(request).toEqual({
      method: "POST",
      url: "/repos/acme/widgets/issues/42/comments",
      authorization: "Bearer test-token",
      body: markdown,
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("creates system pull requests ready for review", async () => {
  let body: Record<string, unknown> | undefined;
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    body = JSON.parse(Buffer.concat(chunks).toString());
    outgoing.setHeader("content-type", "application/json");
    outgoing.end(JSON.stringify({}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP port");
    process.env.GITHUB_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.GITHUB_TOKEN = "test-token";

    await createPullRequest({
      owner: "acme", repository: "widgets", title: "Ready", body: "", head: "feature", base: "main",
    });

    expect(body).toMatchObject({ title: "Ready", head: "feature", base: "main", draft: false });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("rejects a merge when GitHub reports the reviewed head changed", async () => {
  let body: Record<string, unknown> | undefined;
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

    await expect(mergePullRequest("acme", "widgets", 42, "squash", "reviewed-sha"))
      .rejects.toThrow("status 409");
    expect(body).toEqual({ merge_method: "squash", sha: "reviewed-sha" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
