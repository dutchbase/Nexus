import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client, Tool } from "@modelcontextprotocol/client";
import { bindJamToolArguments, boundedJamFetch, callJamToolPages, normalizeJamEvidence, parseJamToolResult, redactJamValue, setJamFetchForTests } from "./jam-client.ts";

afterEach(() => setJamFetchForTests(fetch));

describe("Jam trust boundary", () => {
  it("recursively redacts secrets and request material", () => {
    const value = redactJamValue({ authorization: "Bearer secret-one", cookie: "session=secret-two", nested: { password: "secret-three", access_token: "secret-four" }, requestBody: "private form input", safe: "render failed" });
    expect(JSON.stringify(value)).not.toMatch(/secret-one|secret-two|secret-three|secret-four|private form input/);
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
  });

  it("rejects provider errors and preserves bounded non-JSON prose", () => {
    expect(() => parseJamToolResult({ isError: true, content: [{ type: "text", text: "provider secret" }] })).toThrow("invalid_response");
    expect(parseJamToolResult({ content: [{ type: "text", text: "plain technical context" }] })).toBe("plain technical context");
    expect(() => parseJamToolResult({ content: [{ type: "image", data: "secret" }] })).toThrow("invalid_response");
  });

  it("stops repeated pagination cursors", async () => {
    const callTool = vi.fn(async () => ({ structuredContent: { items: [{ message: "one" }], nextCursor: "same" } }));
    const tool = { name: "getConsoleLogs", inputSchema: { type: "object", properties: { jamId: { type: "string" }, after: { type: "string" } }, required: ["jamId"] } } as Tool;
    expect(await callJamToolPages({ callTool } as unknown as Client, tool, "abc", new AbortController().signal)).toEqual({ items: [{ message: "one" }, { message: "one" }], truncated: true });
    expect(callTool).toHaveBeenCalledTimes(2);
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
});
