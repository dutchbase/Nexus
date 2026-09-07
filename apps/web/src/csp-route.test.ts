import { expect, test, vi } from "vitest";

process.env.DCC_PROCESS_ROLE = "web";
vi.mock("@dcc/database", () => ({
  artifactDataRoot: () => "/primary", legacyArtifactDataRoot: () => "/legacy",
  finalizeArtifact: vi.fn(), inTransaction: vi.fn(), pool: { query: vi.fn() },
  readArtifact: vi.fn(), readStagedArtifact: vi.fn(), stageArtifact: vi.fn(),
}));

const { route } = await import("./server.ts");

function response() {
  return { writeHead: vi.fn(), end: vi.fn() } as any;
}

test("each HTML response uses one fresh nonce in its CSP and trusted script", async () => {
  const first = response();
  const second = response();
  const request = { method: "GET", url: "/login", headers: { host: "test" }, socket: {} } as any;
  await route(request, first);
  await route(request, second);

  const inspect = (value: any) => {
    const headers = value.writeHead.mock.calls[0][1];
    const nonce = String(headers["content-security-policy"]).match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(String(value.end.mock.calls[0][0])).toContain(`<script nonce="${nonce}">`);
    return nonce;
  };
  expect(inspect(first)).not.toBe(inspect(second));
});
