import { afterEach, describe, expect, it, vi } from "vitest";
import { capabilityFromRepo, probeGitHubCapability } from "./index.ts";

describe("capabilityFromRepo", () => {
  it("derives read-only capability from repo permissions", () => {
    expect(capabilityFromRepo({ permissions: { pull: true, push: false } }, null)).toMatchObject({ status: "ok", canRead: true, canWrite: false });
  });
  it("derives write capability from push permission", () => {
    expect(capabilityFromRepo({ permissions: { pull: true, push: true } }, null)).toMatchObject({ canWrite: true });
  });
  it("reports unauthorized when the repo is unreadable", () => {
    expect(capabilityFromRepo(null, null)).toMatchObject({ status: "unauthorized", canRead: false, canWrite: false });
  });
});

describe("probeGitHubCapability", () => {
  const originalApiBaseUrl = process.env.GITHUB_API_BASE_URL;
  const originalToken = process.env.GITHUB_TOKEN;

  afterEach(() => {
    if (originalApiBaseUrl === undefined) delete process.env.GITHUB_API_BASE_URL;
    else process.env.GITHUB_API_BASE_URL = originalApiBaseUrl;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
    vi.unstubAllGlobals();
  });

  it("issues a single read-only GET to /repos/{owner}/{repo}", async () => {
    process.env.GITHUB_API_BASE_URL = "https://github.example/api/v3";
    process.env.GITHUB_TOKEN = "test-token";
    const fetchSpy = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ permissions: { pull: true, push: false } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(probeGitHubCapability("acme", "widgets")).resolves.toMatchObject({ status: "ok", canRead: true, canWrite: false });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://github.example/api/v3/repos/acme/widgets");
    expect((init.method ?? "GET").toUpperCase()).toBe("GET");
  });

  it("reports unauthorized on a 401 with exactly one call (no retry-into-write, no second call)", async () => {
    process.env.GITHUB_API_BASE_URL = "https://github.example/api/v3";
    process.env.GITHUB_TOKEN = "test-token";
    const fetchSpy = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(probeGitHubCapability("acme", "widgets")).resolves.toMatchObject({
      status: "unauthorized", canRead: false, canWrite: false, reason: "GitHub returned HTTP 401",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((fetchSpy.mock.calls[0][1] as RequestInit | undefined)?.method ?? "GET").toBe("GET");
  });

  it("reports unauthorized on a 403 with exactly one call (no retry-into-write, no second call)", async () => {
    process.env.GITHUB_API_BASE_URL = "https://github.example/api/v3";
    process.env.GITHUB_TOKEN = "test-token";
    const fetchSpy = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => new Response("", { status: 403 }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(probeGitHubCapability("acme", "widgets")).resolves.toMatchObject({
      status: "unauthorized", canRead: false, canWrite: false, reason: "GitHub returned HTTP 403",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("maps a 404 to unauthorized with exactly one call", async () => {
    process.env.GITHUB_API_BASE_URL = "https://github.example/api/v3";
    process.env.GITHUB_TOKEN = "test-token";
    const fetchSpy = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(probeGitHubCapability("acme", "widgets")).resolves.toMatchObject({
      status: "unauthorized", canRead: false, canWrite: false, reason: "repository not found or inaccessible with the configured token",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("maps a network failure to unreachable, surfacing the error as reason", async () => {
    vi.useFakeTimers();
    process.env.GITHUB_API_BASE_URL = "https://github.example/api/v3";
    process.env.GITHUB_TOKEN = "test-token";
    const fetchSpy = vi.fn(async () => { throw new TypeError("fetch failed"); });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const resultPromise = probeGitHubCapability("acme", "widgets");
      // GET requests retry on transient failures at 0/250/500ms before probeGitHubCapability
      // catches the exhausted error and classifies it as unreachable.
      await vi.advanceTimersByTimeAsync(750);
      await expect(resultPromise).resolves.toMatchObject({
        status: "unreachable",
        canRead: false,
        canWrite: false,
        reason: expect.any(String),
      });
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports not_configured without calling fetch when GITHUB_TOKEN is missing", async () => {
    process.env.GITHUB_API_BASE_URL = "https://github.example/api/v3";
    delete process.env.GITHUB_TOKEN;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(probeGitHubCapability("acme", "widgets")).resolves.toMatchObject({ status: "not_configured", canRead: false, canWrite: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports not_configured without calling fetch when GITHUB_API_BASE_URL is missing", async () => {
    delete process.env.GITHUB_API_BASE_URL;
    process.env.GITHUB_TOKEN = "test-token";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(probeGitHubCapability("acme", "widgets")).resolves.toMatchObject({ status: "not_configured", canRead: false, canWrite: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
