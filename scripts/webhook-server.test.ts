import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.WEBHOOK_SECRET = "webhook-secret";
process.env.WEBHOOK_PORT = "9003";
const require = createRequire(import.meta.url);
const api = require("../webhook-server.js");

const sha = (letter: string) => letter.repeat(40);
const protectedSha = sha("a");
const config = (dir: string, overrides: Record<string, unknown> = {}) => ({
  secret: "webhook-secret",
  protectedBranch: "master",
  repo: "owner/repo",
  githubApiBaseUrl: "https://github.test",
  requiredCiCheck: "ci",
  deployShPath: join(dir, "deploy;not-a-shell"),
  completionsDir: join(dir, "completions"),
  logsDir: join(dir, "logs"),
  leaseMs: 60_000,
  notification: { url: "https://notify.test", secret: "notify-secret", phone: "recipient-secret" },
  ...overrides,
});

function response() {
  return {
    statusCode: 0,
    body: "",
    writableEnded: false,
    writeHead(code: number) { this.statusCode = code; return this; },
    end(body = "") { this.body = body; this.writableEnded = true; },
  };
}

function signature(body: string) {
  return `sha256=${require("node:crypto").createHmac("sha256", "webhook-secret").update(body).digest("hex")}`;
}

function fakeStore(overrides: Record<string, unknown> = {}) {
  return {
    enqueueDeploymentAttempt: vi.fn(async () => ({ created: true, attempt: { id: "attempt-1" } })),
    claimDeploymentAttempt: vi.fn(async () => ({ kind: "busy", attempt: null })),
    completeDeploymentAttempt: vi.fn(async () => ({})),
    appendDeploymentEvent: vi.fn(async () => ({})),
    ...overrides,
  };
}

function githubFetch(head = protectedSha) {
  return vi.fn(async (url: string) => {
    if (url.includes("/git/ref/heads/")) return { ok: true, json: async () => ({ object: { sha: head } }) };
    return { ok: true, json: async () => ({ check_runs: [{ name: "ci", status: "completed", conclusion: "success", started_at: "2026-01-01" }] }) };
  });
}

async function webhook(overrides: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "webhook-server-"));
  const store = fakeStore(overrides.store as Record<string, unknown>);
  const fetchFn = overrides.fetchFn ?? githubFetch(overrides.head as string | undefined);
  const spawnFn = overrides.spawnFn ?? vi.fn(() => ({ pid: 42, unref() {} }));
  const logs: string[] = [];
  const app = api.createWebhook({ config: config(dir, overrides.config as Record<string, unknown>), store, fetchFn, spawnFn, logger: { info: (line: string) => logs.push(line), warn: (line: string) => logs.push(line), error: (line: string) => logs.push(line) } });
  return { app, dir, store, fetchFn, spawnFn, logs };
}

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("deployment webhook", () => {
  it("requires an explicit protected branch", () => {
    expect(() => api.createWebhook({ config: { ...config(tmpdir()), protectedBranch: "" } })).toThrow("DEPLOY_PROTECTED_BRANCH");
  });

  it("rejects a feature or stale SHA before it enters the durable queue", async () => {
    const ctx = await webhook({ head: protectedSha }); dirs.push(ctx.dir);
    const body = JSON.stringify({ action: "completed", check_run: { name: "ci", conclusion: "success", head_sha: sha("b") } });
    const res = response();

    await ctx.app.handleRequest({ headers: { "x-hub-signature-256": signature(body), "x-github-event": "check_run", "x-github-delivery": "feature" } }, res, body);

    expect(res).toMatchObject({ statusCode: 409, body: "protected_head_mismatch" });
    expect(ctx.store.enqueueDeploymentAttempt).not.toHaveBeenCalled();
  });

  it("queues only the exact protected branch head", async () => {
    const ctx = await webhook(); dirs.push(ctx.dir);
    const body = JSON.stringify({ ref: "refs/heads/master", head_commit: { id: protectedSha } });
    const res = response();

    await ctx.app.handleRequest({ headers: { "x-hub-signature-256": signature(body), "x-github-event": "push", "x-github-delivery": "protected" } }, res, body);

    expect(res.statusCode).toBe(202);
    expect(ctx.store.enqueueDeploymentAttempt).toHaveBeenCalledWith(null, expect.objectContaining({ targetSha: protectedSha, protectedBranch: "master", protectedHeadSha: protectedSha }));
  });

  it("revalidates a queued attempt immediately before launch", async () => {
    const attempt = { id: "attempt-queued", target_sha: protectedSha, protected_branch: "master", owner: "webhook" };
    const ctx = await webhook({ head: sha("b"), store: { claimDeploymentAttempt: vi.fn(async () => ({ kind: "claimed", attempt })) } }); dirs.push(ctx.dir);

    await ctx.app.processNext();

    expect(ctx.spawnFn).not.toHaveBeenCalled();
    expect(ctx.store.completeDeploymentAttempt).toHaveBeenCalledWith(null, expect.objectContaining({ attemptId: "attempt-queued", state: "blocked" }));
  });

  it("treats a duplicate delivery as already processed without launching", async () => {
    const ctx = await webhook({ store: { enqueueDeploymentAttempt: vi.fn(async () => ({ created: false, duplicate: "delivery", attempt: { id: "attempt-1" } })) } }); dirs.push(ctx.dir);
    const body = JSON.stringify({ ref: "refs/heads/master", head_commit: { id: protectedSha } });
    const res = response();

    await ctx.app.handleRequest({ headers: { "x-hub-signature-256": signature(body), "x-github-event": "push", "x-github-delivery": "duplicate" } }, res, body);

    expect(res).toMatchObject({ statusCode: 200, body: "already_processed" });
    expect(ctx.spawnFn).not.toHaveBeenCalled();
  });

  it("blocks malformed completion markers", async () => {
    const ctx = await webhook(); dirs.push(ctx.dir);
    const marker = join(ctx.dir, "bad.done");
    await writeFile(marker, "not json");

    await ctx.app.finalizeAttempt({ id: "attempt-1", target_sha: protectedSha, owner: "webhook" }, marker);

    expect(ctx.store.completeDeploymentAttempt).toHaveBeenCalledWith(null, expect.objectContaining({ state: "blocked", attemptId: "attempt-1" }));
  });

  it("launches one recovered attempt and leaves the second recovery blocked", async () => {
    const recovered = { id: "attempt-recovered", target_sha: protectedSha, protected_branch: "master", owner: "webhook" };
    const claimDeploymentAttempt = vi.fn()
      .mockResolvedValueOnce({ kind: "recovered", attempt: recovered })
      .mockResolvedValueOnce({ kind: "blocked", attempt: recovered });
    const ctx = await webhook({ store: { claimDeploymentAttempt } }); dirs.push(ctx.dir);

    await ctx.app.recoverOnBoot();
    await ctx.app.recoverOnBoot();

    expect(ctx.spawnFn).toHaveBeenCalledTimes(1);
  });

  it("passes metacharacter paths as argv with no shell", async () => {
    const ctx = await webhook(); dirs.push(ctx.dir);
    const marker = join(ctx.dir, "marker;still-data.done");

    ctx.app.launchDeploy(protectedSha, marker, "attempt-1", "master");

    expect(ctx.spawnFn).toHaveBeenCalledWith(join(ctx.dir, "deploy;not-a-shell"), [protectedSha, marker, "attempt-1", "master"], expect.objectContaining({ detached: true, shell: false }));
  });

  it("returns the exact bounded rejection before authentication or parsing", async () => {
    const ctx = await webhook(); dirs.push(ctx.dir);
    const req = new EventEmitter() as EventEmitter & { method: string; url: string; headers: Record<string, string> };
    req.method = "POST"; req.url = "/deploy"; req.headers = { "x-hub-signature-256": "invalid" };
    const res = response();
    const pending = ctx.app.handleHttp(req, res);
    req.emit("data", Buffer.alloc(1024 * 1024 + 1, "{"));
    req.emit("end");
    await pending;

    expect(res).toMatchObject({ statusCode: 413, body: "webhook_body_too_large" });
    expect(ctx.fetchFn).not.toHaveBeenCalled();
    expect(ctx.store.enqueueDeploymentAttempt).not.toHaveBeenCalled();
  });

  it("records bounded notification outcomes without leaking secrets", async () => {
    const ctx = await webhook({ fetchFn: vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, text: async () => "provider response body" })
      .mockRejectedValueOnce(new Error("network recipient-secret notify-secret")) }); dirs.push(ctx.dir);

    await expect(ctx.app.sendNotification("deployed")).resolves.toBe("accepted");
    await expect(ctx.app.sendNotification("deployed")).resolves.toBe("failed_http");
    await expect(ctx.app.sendNotification("deployed")).resolves.toBe("failed_network");
    await expect(ctx.app.sendNotification("deployed", { url: "", secret: "", phone: "" })).resolves.toBe("disabled_config");
    expect(JSON.stringify(ctx.logs)).not.toMatch(/recipient-secret|notify-secret|provider response body|network recipient-secret/);
  });
});
