import { afterEach, describe, expect, it, vi } from "vitest";
import { SdkError, SdkErrorCode, type Client, type Tool } from "@modelcontextprotocol/client";
import { JamImportError, bindJamToolArguments, boundedJamFetch, callJamToolPages, fetchJamContext, jamEndpoint, normalizeJamEvidence, parseJamToolResult, redactJamValue, safeJamSchema, setJamFetchForTests } from "./jam-client.ts";

afterEach(() => setJamFetchForTests(fetch));

describe("Jam trust boundary", () => {
  it("allows only a non-production loopback test endpoint", () => {
    expect(jamEndpoint({ NODE_ENV: "test", DCC_JAM_TEST_ENDPOINT: "http://127.0.0.1:4321/mcp" } as any)).toBe("http://127.0.0.1:4321/mcp");
    expect(jamEndpoint({ NODE_ENV: "production", DCC_JAM_TEST_ENDPOINT: "http://127.0.0.1:4321/mcp" } as any)).toBe("https://mcp.jam.dev/mcp");
    expect(() => jamEndpoint({ NODE_ENV: "test", DCC_JAM_TEST_ENDPOINT: "https://evil.test/mcp" } as any)).toThrow("access_denied");
  });
  it("recursively redacts secrets and request material", () => {
    const value = redactJamValue({ authorization: "Bearer secret-one", cookie: "session=secret-two", nested: { password: "secret-three", access_token: "secret-four" }, requestBody: "private form input", safe: "render failed; token=plain-one apiKey: 'plain-two' password:plain-three cookie=plain-four auth:plain-five refresh_token=plain-six client_secret:plain-seven access-token=plain-eight clientSecret:plain-nine REFRESHTOKEN:plain-ten" });
    expect(JSON.stringify(value)).not.toMatch(/secret-one|secret-two|secret-three|secret-four|private form input/);
    expect(JSON.stringify(value)).not.toMatch(/plain-(?:one|two|three|four|five|six|seven|eight|nine|ten)/);
    expect(JSON.stringify(value)).toContain("render failed");
  });

  it("projects technical evidence without query strings or typed values", () => {
    const evidence = normalizeJamEvidence({ id: "abc", url: "https://jam.dev/c/abc" }, {
      details: { browser: "Chrome", os: "Linux", viewport: "1200x800", pageUrl: "https://app.test/fail?token=secret" },
      console: [{ level: "error", message: "<script>alert(1)</script> at https://app.test/a?token=secret" }],
      network: [{ method: "POST", url: "https://api.test/orders?token=secret#x", status: 500, duration: 12, requestBody: "private" }],
      events: [{ type: "input", description: "typed", value: "private" }], metadata: { safe: "yes", apiKey: "secret" },
    });
    expect(evidence.device.pageUrl).toBe("https://app.test/fail");
    expect(evidence.console[0].message).toContain("<script>");
    expect(evidence.network).toEqual([{ method: "POST", url: "https://api.test/orders", status: 500, durationMs: 12 }]);
    expect(JSON.stringify(evidence)).not.toContain("private");
  });

  it("records missing optional sections", () => {
    expect(normalizeJamEvidence({ id: "x", url: "https://jam.dev/c/x" }, { details: { browser: "Firefox" } }).unavailableSections)
      .toEqual(["console", "network", "events", "metadata", "transcript"]);
  });

  it("marks provider pagination caps and deterministically caps stored evidence", () => {
    const evidence = normalizeJamEvidence({ id: "x", url: "https://jam.dev/c/x" }, { details: { browser: "x" }, console: { items: Array.from({ length: 600 }, (_, index) => ({ level: "log", message: `${index}:${"x".repeat(1000)}` })), truncated: true }, transcript: "😀".repeat(200_000) });
    expect(evidence.console).toHaveLength(0);
    expect(evidence.truncatedSections).toEqual(expect.arrayContaining(["console", "transcript"]));
    expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(256 * 1024);
  });

  it("binds only an advertised string id and optional pagination", () => {
    expect(bindJamToolArguments({ type: "object", properties: { jamId: { type: "string" }, limit: { type: "number" } }, required: ["jamId"] }, "abc", { limit: 100, after: "ignored" }))
      .toEqual({ jamId: "abc", limit: 100 });
    expect(() => bindJamToolArguments({ type: "object", properties: { capture: { type: "string" } }, required: ["capture"] }, "abc"))
      .toThrow("unsupported_schema");
    expect(() => bindJamToolArguments({ type: "object", properties: { jamId: { type: "string" }, id: { type: "string" } }, required: ["jamId"] }, "abc")).toThrow("unsupported_schema");
    expect(() => bindJamToolArguments({ type: "object", properties: { jamId: { type: "string" }, id: { type: "number" } }, required: ["jamId"] }, "abc")).toThrow("unsupported_schema");
    expect(() => bindJamToolArguments({ type: "object", properties: { jamId: { type: "string" }, after: { type: "string" } }, required: ["jamId", "after"] }, "abc")).toThrow("unsupported_schema");
    expect(() => bindJamToolArguments({ type: "object", properties: { jamId: { type: "string" }, limit: { type: "string" } }, required: ["jamId"] }, "abc")).toThrow("unsupported_schema");
    expect(() => bindJamToolArguments({ type: "object", properties: { jamId: { type: "string" }, after: { type: "boolean" } }, required: ["jamId"] }, "abc")).toThrow("unsupported_schema");
  });

  it("accepts a numeric pagination cursor, matching Jam's console/network/events tools", () => {
    expect(bindJamToolArguments({ type: "object", properties: { jamId: { type: "string" }, after: { type: "number" } }, required: ["jamId"] }, "abc", { after: 42 }))
      .toEqual({ jamId: "abc", after: 42 });
  });

  it("reduces recorded schemas to structural fields recursively", () => {
    expect(safeJamSchema({ type: "object", description: "secret", properties: { rows: { type: "array", examples: ["secret"], items: { type: "object", properties: { id: { type: "string", default: "secret" } }, required: ["id", 4] } } }, required: ["rows"] }))
      .toEqual({ type: "object", properties: { rows: { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } }, required: ["rows"] });
  });

  it("rejects provider errors and preserves bounded non-JSON prose", () => {
    expect(() => parseJamToolResult({ isError: true, content: [{ type: "text", text: "provider secret" }] })).toThrow("invalid_response");
    expect(parseJamToolResult({ content: [{ type: "text", text: "plain technical context" }] })).toBe("plain technical context");
    expect(() => parseJamToolResult({ content: [{ type: "image", data: "secret" }] })).toThrow("invalid_response");
  });

  it("parses the JSON block even when getDetails also returns a prose investigation guide", () => {
    expect(parseJamToolResult({ content: [
      { type: "text", text: '{"jamId":"abc","type":"video"}' },
      { type: "text", text: "## Investigation Guide\n\n1. Analyze the video." },
    ] })).toEqual({ jamId: "abc", type: "video" });
  });

  it("normalizes Jam's real field names: nested systemInfo, network_*/event_type rows, and an events array key", () => {
    const evidence = normalizeJamEvidence({ id: "x", url: "https://jam.dev/c/x" }, {
      details: { systemInfo: { browser: { name: "Chromium" }, os: { name: "Linux" }, screenDimensions: { width: 2056, height: 1023 } } },
      network: { total: 1, returned: 1, hasMore: false, nextCursor: null, events: [
        { event_index: 1, ts: "2026-09-10 15:35:07.103", network_url: "https://api.test/orders", network_method: "GET", network_status: 200, network_duration_ms: 5.1 },
      ] },
      events: { total: 1, returned: 1, hasMore: false, nextCursor: null, events: [
        { event_index: 6, ts: "2026-09-10 15:35:08.190", event_type: "navigation", navigation_url: "https://app.test/page", navigation_path: "/page" },
      ] },
    });
    expect(evidence.device).toEqual({ browser: "Chromium", os: "Linux", viewport: "2056x1023" });
    expect(evidence.network).toEqual([{ method: "GET", url: "https://api.test/orders", status: 200, durationMs: 5.1 }]);
    expect(evidence.events).toHaveLength(1);
    expect(evidence.events[0].type).toBe("navigation");
    expect(evidence.events[0].time).toBe("2026-09-10 15:35:08.190");
    expect(evidence.events[0].description).toContain("navigation_path=/page");
  });

  it("collects rows from Jam's real 'events' response envelope, not just items/data", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: JSON.stringify({ total: 1, returned: 1, hasMore: false, nextCursor: null, events: [{ event_type: "network" }] }) }] }));
    const tool = { name: "getNetworkRequests", inputSchema: { type: "object", properties: { jamId: { type: "string" } }, required: ["jamId"] } } as Tool;
    expect(await callJamToolPages({ callTool } as unknown as Client, tool, "abc", new AbortController().signal)).toEqual({ items: [{ event_type: "network" }], truncated: false });
  });

  it("stops repeated pagination cursors", async () => {
    const callTool = vi.fn(async () => ({ structuredContent: { items: [{ message: "one" }], nextCursor: "same" } }));
    const tool = { name: "getConsoleLogs", inputSchema: { type: "object", properties: { jamId: { type: "string" }, after: { type: "string" } }, required: ["jamId"] } } as Tool;
    expect(await callJamToolPages({ callTool } as unknown as Client, tool, "abc", new AbortController().signal)).toEqual({ items: [{ message: "one" }, { message: "one" }], truncated: true });
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it("pages through a numeric cursor, matching Jam's real console/network/events schema", async () => {
    let call = 0;
    const callTool = vi.fn(async (_request: unknown) => {
      call += 1;
      return call === 1
        ? { structuredContent: { items: [{ message: "first" }], nextCursor: 5 } }
        : { structuredContent: { items: [{ message: "second" }] } };
    });
    const tool = { name: "getConsoleLogs", inputSchema: { type: "object", properties: { jamId: { type: "string" }, limit: { type: "number" }, after: { type: "number" } }, required: ["jamId"] } } as Tool;
    expect(await callJamToolPages({ callTool } as unknown as Client, tool, "abc", new AbortController().signal)).toEqual({ items: [{ message: "first" }, { message: "second" }], truncated: false });
    expect(callTool).toHaveBeenCalledTimes(2);
    expect((callTool.mock.calls[1][0] as any).arguments).toEqual({ jamId: "abc", limit: 100, after: 5 });
  });

  it("allows only the fixed endpoint and rejects redirects", async () => {
    await expect(boundedJamFetch("https://localhost/private")).rejects.toThrow("access_denied");
    const mock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.test" } }));
    setJamFetchForTests(mock as typeof fetch);
    await expect(boundedJamFetch("https://mcp.jam.dev/mcp")).rejects.toThrow("access_denied");
    expect((mock.mock.calls as unknown[][])[0][1]).toMatchObject({ redirect: "error" });
  });

  it("caps response bytes and maps safe HTTP errors", async () => {
    setJamFetchForTests((async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1))) as typeof fetch);
    await expect(boundedJamFetch("https://mcp.jam.dev/mcp")).rejects.toThrow("invalid_response");
    setJamFetchForTests((async () => new Response("provider secret", { status: 429, headers: { "retry-after": "999" } })) as typeof fetch);
    await expect(boundedJamFetch("https://mcp.jam.dev/mcp")).rejects.toMatchObject({ code: "rate_limited", retryable: true, retryAfterSeconds: 300, message: "rate_limited" });
  });

  it("honors an abort deadline", async () => {
    setJamFetchForTests(((_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }))) as typeof fetch);
    await expect(boundedJamFetch("https://mcp.jam.dev/mcp", { signal: AbortSignal.timeout(5) })).rejects.toMatchObject({ code: "timeout" });
  });

  it("classifies only transport failures as retryable", async () => {
    setJamFetchForTests((async () => { throw new TypeError("network secret"); }) as typeof fetch);
    await expect(boundedJamFetch("https://mcp.jam.dev/mcp")).rejects.toMatchObject({ code: "unavailable", retryable: true });
    setJamFetchForTests((async () => { throw new Error("protocol secret"); }) as typeof fetch);
    await expect(boundedJamFetch("https://mcp.jam.dev/mcp")).rejects.toMatchObject({ code: "invalid_response", retryable: false, message: "invalid_response" });
  });
});

const source = { id: "abc", url: "https://jam.dev/c/abc" };
const details = { name: "getDetails", inputSchema: { type: "object", properties: { jamId: { type: "string" } }, required: ["jamId"] } } as Tool;
const optional = ["getConsoleLogs", "getNetworkRequests", "getUserEvents", "getMetadata", "getVideoTranscript"].map((name) => ({ ...details, name } as Tool));

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    connect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({ tools: [details, ...optional] })),
    callTool: vi.fn(async ({ name }: { name: string }) => ({ structuredContent: name === "getDetails" ? { browser: "Firefox" } : { items: [] } })),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("Jam MCP integration boundary", () => {
  it("discovers tools, passes auth to transport, and always closes", async () => {
    const client = fakeClient(), createTransport = vi.fn(() => ({} as never));
    const result = await fetchJamContext(source, { token: "token-value", signal: new AbortController().signal }, { createClient: () => client as never, createTransport });
    expect(result.state).toBe("ready");
    expect(createTransport).toHaveBeenCalledWith("token-value");
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("returns partial evidence when optional tools are missing or fail", async () => {
    const missing = fakeClient({ listTools: vi.fn(async () => ({ tools: [details] })) });
    await expect(fetchJamContext(source, { token: "x", signal: new AbortController().signal }, { createClient: () => missing as never, createTransport: () => ({} as never) })).resolves.toMatchObject({ state: "partial" });
    const failed = fakeClient({ callTool: vi.fn(async ({ name }: { name: string }) => { if (name === "getConsoleLogs") throw new JamImportError("unavailable", true); return { structuredContent: name === "getDetails" ? { browser: "Firefox" } : { items: [] } }; }) });
    const result = await fetchJamContext(source, { token: "x", signal: new AbortController().signal }, { createClient: () => failed as never, createTransport: () => ({} as never) });
    expect(result.state).toBe("partial");
    expect(result.evidence.unavailableSections).toContain("console");
  });

  it("paginates discovered collection tools through the adapter", async () => {
    let consoleCalls = 0;
    const client = fakeClient({ callTool: vi.fn(async ({ name }: { name: string }) => {
      if (name === "getDetails") return { structuredContent: { browser: "Firefox" } };
      if (name === "getConsoleLogs") return { structuredContent: consoleCalls++ === 0 ? { items: [{ message: "one" }], nextCursor: "next" } : { items: [{ message: "two" }] } };
      return { structuredContent: { items: [] } };
    }) });
    const result = await fetchJamContext(source, { token: "x", signal: new AbortController().signal }, { createClient: () => client as never, createTransport: () => ({} as never) });
    expect(result.evidence.console.map((row) => row.message)).toEqual(["one", "two"]);
    expect(consoleCalls).toBe(2);
  });

  it("fails safely on discovery, required details, and unknown SDK errors", async () => {
    const undiscoverable = fakeClient({ listTools: vi.fn(async () => ({ tools: optional })) });
    await expect(fetchJamContext(source, { token: "x", signal: new AbortController().signal }, { createClient: () => undiscoverable as never, createTransport: () => ({} as never) })).rejects.toMatchObject({ code: "unsupported_schema", retryable: false });
    const detailsFailure = fakeClient({ callTool: vi.fn(async () => { throw new JamImportError("access_denied", false); }) });
    await expect(fetchJamContext(source, { token: "x", signal: new AbortController().signal }, { createClient: () => detailsFailure as never, createTransport: () => ({} as never) })).rejects.toMatchObject({ code: "access_denied" });
    const protocolFailure = fakeClient({ listTools: vi.fn(async () => { throw new Error("provider secret"); }) });
    await expect(fetchJamContext(source, { token: "x", signal: new AbortController().signal }, { createClient: () => protocolFailure as never, createTransport: () => ({} as never) })).rejects.toMatchObject({ code: "invalid_response", retryable: false, message: "invalid_response" });
  });

  it("maps the typed SDK request timeout to a safe retryable timeout", async () => {
    const timeoutError = new SdkError(SdkErrorCode.RequestTimeout, "provider secret");
    const client = fakeClient({ callTool: vi.fn(async () => { throw timeoutError; }) });
    await expect(fetchJamContext(source, { token: "x", signal: new AbortController().signal }, { createClient: () => client as never, createTransport: () => ({} as never) })).rejects.toMatchObject({ code: "timeout", retryable: true, message: "timeout" });
  });

  it.each([
    Object.assign(new Error("protocol failure"), { code: "REQUEST_TIMEOUT" }),
    Object.assign(new Error("protocol failure"), { code: "ETIMEDOUT" }),
    Object.assign(new Error("protocol failure"), { name: "TimeoutError" }),
    new Error("Request timed out while parsing protocol data"),
  ])("keeps a timeout lookalike nonretryable", async (lookalike) => {
    const client = fakeClient({ callTool: vi.fn(async () => { throw lookalike; }) });
    await expect(fetchJamContext(source, { token: "x", signal: new AbortController().signal }, { createClient: () => client as never, createTransport: () => ({} as never) })).rejects.toMatchObject({ code: "invalid_response", retryable: false, message: "invalid_response" });
  });

  it("closes after partial connect and maps an expired deadline to retryable timeout", async () => {
    const client = fakeClient({ connect: vi.fn(async () => { throw new Error("partial connect secret"); }) });
    const expired = AbortSignal.abort();
    await expect(fetchJamContext(source, { token: "x", signal: new AbortController().signal }, { createClient: () => client as never, createTransport: () => ({} as never), timeout: () => expired })).rejects.toMatchObject({ code: "timeout", retryable: true });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("hashes normalized evidence deterministically", async () => {
    const first = fakeClient(), second = fakeClient();
    const run = (client: ReturnType<typeof fakeClient>) => fetchJamContext(source, { token: "x", signal: new AbortController().signal }, { createClient: () => client as never, createTransport: () => ({} as never) });
    expect((await run(first)).contentHash).toBe((await run(second)).contentHash);
  });
});
