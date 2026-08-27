import { expect, test, vi, beforeEach } from "vitest";
import { checkImageExists } from "./registry.ts";

beforeEach(() => { vi.restoreAllMocks(); });

test("returns exists:true and a digest on a 200 manifest HEAD, using an anonymous token", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ token: "anon-token" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(null, { status: 200, headers: { "docker-content-digest": "sha256:abc" } }));
  const result = await checkImageExists("ghcr.io", "acme/jobs-platform", "sha-deadbeef");
  expect(result).toEqual({ exists: true, digest: "sha256:abc", checkedAt: expect.any(String), authRequired: false });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("returns exists:false on a 404 manifest HEAD", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ token: "anon-token" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(null, { status: 404 }));
  const result = await checkImageExists("ghcr.io", "acme/jobs-platform", "sha-missing");
  expect(result.exists).toBe(false);
  expect(result.authRequired).toBe(false);
});

test("falls back to GHCR_READ_TOKEN and reports authRequired:true when anonymous access is denied", async () => {
  process.env.GHCR_READ_TOKEN = "server-side-token";
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ token: "anon-token" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(null, { status: 401 })) // anonymous manifest HEAD denied
    .mockResolvedValueOnce(new Response(null, { status: 200, headers: { "docker-content-digest": "sha256:xyz" } })); // retried with GHCR_READ_TOKEN
  const result = await checkImageExists("ghcr.io", "acme/private-repo", "sha-deadbeef");
  expect(result).toEqual({ exists: true, digest: "sha256:xyz", checkedAt: expect.any(String), authRequired: true });
  delete process.env.GHCR_READ_TOKEN;
});

test("returns exists:false with error:transient on a 429, instead of throwing", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ token: "anon-token" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(null, { status: 429 }));
  const result = await checkImageExists("ghcr.io", "acme/jobs-platform", "sha-deadbeef");
  expect(result).toEqual({ exists: false, checkedAt: expect.any(String), authRequired: false, error: "transient" });
});

test("returns exists:false with error:transient on a 503, instead of throwing", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ token: "anon-token" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  const result = await checkImageExists("ghcr.io", "acme/jobs-platform", "sha-deadbeef");
  expect(result).toEqual({ exists: false, checkedAt: expect.any(String), authRequired: false, error: "transient" });
});

test("still throws on a genuinely unexpected anonymous status with no GHCR_READ_TOKEN configured", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ token: "anon-token" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(null, { status: 418 }));
  await expect(checkImageExists("ghcr.io", "acme/jobs-platform", "sha-deadbeef")).rejects.toThrow(/status 418/);
});

test("sends the multi-media-type accept header covering OCI and Docker manifest/index formats", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ token: "anon-token" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }));
  await checkImageExists("ghcr.io", "acme/jobs-platform", "sha-deadbeef");
  const manifestCall = fetchMock.mock.calls[1];
  const headers = manifestCall[1]?.headers as Record<string, string>;
  expect(headers.accept).toBe(
    "application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json",
  );
});
