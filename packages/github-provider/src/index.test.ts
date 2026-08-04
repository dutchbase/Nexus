import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import {
  createPullRequest,
  createPullRequestComment,
  findOpenPullRequestForHead,
  listPullRequests,
  markReadyForReview,
  mergePullRequest,
} from "./index.ts";

const originalApiBaseUrl = process.env.GITHUB_API_BASE_URL;
const originalToken = process.env.GITHUB_TOKEN;

afterEach(() => {
  if (originalApiBaseUrl === undefined) delete process.env.GITHUB_API_BASE_URL;
  else process.env.GITHUB_API_BASE_URL = originalApiBaseUrl;
  if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalToken;
});

async function withServer(
  handler: (incoming: IncomingMessage, outgoing: ServerResponse) => void | Promise<void>,
  run: (baseUrl: string) => Promise<void>,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP port");
    process.env.GITHUB_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.GITHUB_TOKEN = "test-token";
    await run(process.env.GITHUB_API_BASE_URL);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("qualifies an open pull request head with its owner", async () => {
  let url = "";
  await withServer((incoming, outgoing) => {
    url = incoming.url ?? "";
    outgoing.setHeader("content-type", "application/json");
    outgoing.end("[]");
  }, async () => {
    await expect(findOpenPullRequestForHead("acme", "widgets", "feature")).resolves.toBeNull();
  });
  expect(url).toBe("/repos/acme/widgets/pulls?state=open&head=acme%3Afeature");
});

test("lists all same-origin pages once and retains partial recovery metadata", async () => {
  let requests = 0;
  await withServer((incoming, outgoing) => {
    requests++;
    if (incoming.url?.includes("page=2")) {
      outgoing.statusCode = 503;
      outgoing.end("internal diagnostic body");
      return;
    }
    outgoing.setHeader("content-type", "application/json");
    outgoing.setHeader("link", `</repos/acme/widgets/pulls?state=all&per_page=100&page=2>; rel="next"`);
    outgoing.end(JSON.stringify([{ number: 1 }, { number: 1 }]));
  }, async () => {
    const result = await listPullRequests("acme", "widgets");
    expect(result).toMatchObject({ complete: false, items: [{ number: 1 }], errorCode: "transient" });
    expect(result.cursor).toContain("page=2");
    expect(result.fetchedAt).toEqual(expect.any(String));
  });
  expect(requests).toBe(4);
});

test("uses the configured Enterprise GraphQL endpoint", async () => {
  const urls: string[] = [];
  await withServer((incoming, outgoing) => {
    urls.push(incoming.url ?? "");
    outgoing.setHeader("content-type", "application/json");
    outgoing.end(incoming.url?.endsWith("/graphql") ? JSON.stringify({ data: {} }) : JSON.stringify({ node_id: "PR_node" }));
  }, async (baseUrl) => {
    process.env.GITHUB_API_BASE_URL = `${baseUrl}/api/v3`;
    await markReadyForReview("acme", "widgets", 1);
  });
  expect(urls).toContain("/api/graphql");
});

test("applies abort and safe error policy", async () => {
  const realFetch = globalThis.fetch;
  let signal: AbortSignal | undefined;
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Response("test-token secret body", { status: 500 });
  });
  process.env.GITHUB_API_BASE_URL = "https://github.example/api/v3";
  process.env.GITHUB_TOKEN = "test-token";
  try {
    await expect(createPullRequest({ owner: "acme", repository: "widgets", title: "x", body: "", head: "f", base: "main" }))
      .rejects.toThrow(/status 500/);
    expect(signal).toBeInstanceOf(AbortSignal);
    await expect(createPullRequest({ owner: "acme", repository: "widgets", title: "test-token", body: "secret body", head: "f", base: "main" }))
      .rejects.toThrow("status 500");
  } finally {
    vi.stubGlobal("fetch", realFetch);
  }
});

test("returns rate-limit recovery metadata without exposing the response body", async () => {
  await withServer((_incoming, outgoing) => {
    outgoing.statusCode = 403;
    outgoing.setHeader("x-ratelimit-remaining", "0");
    outgoing.setHeader("x-ratelimit-reset", "1780000000");
    outgoing.end("test-token provider diagnostic");
  }, async () => {
    const result = await listPullRequests("acme", "widgets");
    expect(result).toMatchObject({ complete: false, items: [], errorCode: "rate_limited", retryAt: "2026-05-28T20:26:40.000Z" });
  });
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
