import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import {
  createPullRequest,
  createPullRequestComment,
  findOpenPullRequestForHead,
  getPullRequest,
  listPullRequests,
  markReadyForReview,
  mergeBranch,
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

test("lists successful two-page results once", async () => {
  await withServer((incoming, outgoing) => {
    outgoing.setHeader("content-type", "application/json");
    if (incoming.url?.includes("page=2")) {
      outgoing.end(JSON.stringify([{ number: 2 }, { number: 3 }]));
      return;
    }
    outgoing.setHeader("link", `</repos/acme/widgets/pulls?state=all&per_page=100&page=2>; rel="next"`);
    outgoing.end(JSON.stringify([{ number: 1 }, { number: 2 }]));
  }, async () => {
    const result = await listPullRequests("acme", "widgets");
    expect(result).toMatchObject({ complete: true, cursor: null });
    expect(result.items.map(({ number }) => number)).toEqual([1, 2, 3]);
  });
});

test("routes the mark-ready pull-request mutation to configured Enterprise GraphQL", async () => {
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

test("applies a ten-second abort and safe error policy", async () => {
  const realFetch = globalThis.fetch;
  const abortTimeout = vi.spyOn(AbortSignal, "timeout");
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
    expect(abortTimeout).toHaveBeenCalledWith(10_000);
    await expect(createPullRequest({ owner: "acme", repository: "widgets", title: "test-token", body: "secret body", head: "f", base: "main" }))
      .rejects.toThrow("status 500");
  } finally {
    vi.stubGlobal("fetch", realFetch);
    abortTimeout.mockRestore();
  }
});

test("uses 250 then 500 millisecond GET retry backoff", async () => {
  vi.useFakeTimers();
  const realFetch = globalThis.fetch;
  const fetchSpy = vi.fn(async () => new Response("unavailable", { status: 503 }));
  vi.stubGlobal("fetch", fetchSpy);
  process.env.GITHUB_API_BASE_URL = "https://github.example/api/v3";
  process.env.GITHUB_TOKEN = "test-token";
  try {
    const result = findOpenPullRequestForHead("acme", "widgets", "feature").then(() => null, (error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ message: "GitHub provider request failed with status 503" });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  } finally {
    vi.stubGlobal("fetch", realFetch);
    vi.useRealTimers();
  }
});

test("redacts malformed successful response bodies", async () => {
  await withServer((_incoming, outgoing) => {
    outgoing.setHeader("content-type", "application/json");
    outgoing.end("test-token malformed provider body");
  }, async () => {
    await expect(getPullRequest("acme", "widgets", 1)).rejects.toThrow("GitHub provider response decoding failed");
    await expect(getPullRequest("acme", "widgets", 1)).rejects.not.toThrow(/test-token|malformed provider body/);
  });
});

test("redacts malformed successful branch-merge bodies", async () => {
  await withServer((_incoming, outgoing) => {
    outgoing.statusCode = 201;
    outgoing.setHeader("content-type", "application/json");
    outgoing.end("test-token malformed merge body");
  }, async () => {
    await expect(mergeBranch("acme", "widgets", "main", "feature"))
      .rejects.toThrow("GitHub provider response decoding failed");
  });
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

test("classifies 429 limits with Retry-After recovery metadata", async () => {
  await withServer((_incoming, outgoing) => {
    outgoing.statusCode = 429;
    outgoing.setHeader("retry-after", "60");
    outgoing.end("secondary rate limit");
  }, async () => {
    await expect(listPullRequests("acme", "widgets"))
      .resolves.toMatchObject({ complete: false, errorCode: "rate_limited", retryAt: expect.any(String) });
  });
});

test("classifies secondary and GraphQL rate limits with recovery times", async () => {
  let graphql = false;
  await withServer((incoming, outgoing) => {
    graphql = incoming.url?.endsWith("/graphql") ?? false;
    outgoing.setHeader("content-type", "application/json");
    outgoing.setHeader("retry-after", "60");
    if (graphql) outgoing.end(JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "secondary rate limit" }] }));
    else if (incoming.url?.startsWith("/api/v3/")) outgoing.end(JSON.stringify({ node_id: "PR_node" }));
    else outgoing.statusCode = 403, outgoing.end("secondary rate limit");
  }, async (baseUrl) => {
    const rest = await listPullRequests("acme", "widgets");
    expect(rest).toMatchObject({ complete: false, errorCode: "rate_limited", retryAt: expect.any(String) });
    process.env.GITHUB_API_BASE_URL = `${baseUrl}/api/v3`;
    await expect(markReadyForReview("acme", "widgets", 1)).rejects.toMatchObject({ code: "rate_limited", retryAt: expect.any(String) });
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
