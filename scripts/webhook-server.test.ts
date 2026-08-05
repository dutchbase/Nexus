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
    endCalls: 0,
    writeHead(code: number) { this.statusCode = code; return this; },
    end(body = "") { this.body = body; this.writableEnded = true; this.endCalls += 1; },
  };
}

function signature(body: string | Buffer) {
  return `sha256=${require("node:crypto").createHmac("sha256", "webhook-secret").update(body).digest("hex")}`;
}

function fakeStore(overrides: Record<string, unknown> = {}) {
  return {
    enqueueDeploymentAttempt: vi.fn(async () => ({ created: true, attempt: { id: "attempt-1" } })),
    claimDeploymentAttempt: vi.fn(async () => ({ kind: "busy", attempt: null })),
    recordDeploymentLaunchIntent: vi.fn(async () => ({})),
    recordDeploymentLaunch: vi.fn(async () => ({})),
    renewDeploymentLease: vi.fn(async () => ({})),
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
  const app = api.createWebhook({ config: config(dir, overrides.config as Record<string, unknown>), store, fetchFn, spawnFn, isAliveFn: overrides.isAliveFn, isCurrentReleaseFn: overrides.isCurrentReleaseFn, logger: { info: (line: string) => logs.push(line), warn: (line: string) => logs.push(line), error: (line: string) => logs.push(line) } });
  return { app, dir, store, fetchFn, spawnFn, logs };
}

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("deployment webhook", () => {
  it("requires an explicit protected branch", () => {
    expect(() => api.createWebhook({ config: { ...config(tmpdir()), protectedBranch: "" } })).toThrow("DEPLOY_PROTECTED_BRANCH");
  });

  it("durably records a rejected feature or stale SHA before returning 409", async () => {
    const ctx = await webhook({ head: protectedSha }); dirs.push(ctx.dir);
    const body = JSON.stringify({ action: "completed", check_run: { name: "ci", conclusion: "success", head_sha: sha("b") } });
    const res = response();

    await ctx.app.handleRequest({ headers: { "x-hub-signature-256": signature(body), "x-github-event": "check_run", "x-github-delivery": "feature" } }, res, body);

    expect(res).toMatchObject({ statusCode: 409, body: "protected_head_mismatch" });
    expect(ctx.store.enqueueDeploymentAttempt).toHaveBeenCalledWith(null, {
      deliveryId: "feature",
      eventType: "check_run",
      targetRef: "refs/heads/master",
      targetSha: sha("b"),
      protectedBranch: "master",
      protectedHeadSha: protectedSha,
      checkEvidence: { requiredCheck: "ci", conclusion: "success", rejectionReason: "protected_head_mismatch" },
      state: "rejected",
    });
    expect(JSON.stringify(ctx.store.enqueueDeploymentAttempt.mock.calls)).not.toMatch(/webhook-secret|x-hub-signature|check_run.*action/);
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

  it("leaves a reload-pending success marker for an old release without finalizing it", async () => {
    const ctx = await webhook({ isCurrentReleaseFn: () => false }); dirs.push(ctx.dir);
    const marker = join(ctx.dir, "pending.done");
    await writeFile(marker, JSON.stringify({ attemptId: "attempt-1", sha: protectedSha, exitCode: 0, reloadPending: true }));

    await expect(ctx.app.finalizeAttempt({ id: "attempt-1", target_sha: protectedSha, owner: "webhook" }, marker)).resolves.toBe(false);

    expect(ctx.store.completeDeploymentAttempt).not.toHaveBeenCalled();
    await expect(require("node:fs/promises").access(marker)).resolves.toBeUndefined();
  });

  it("finalizes a reload-pending success marker only during current-release boot recovery", async () => {
    const marker = join(tmpdir(), "pending-current-release.done");
    const attempt = { id: "attempt-current", target_sha: protectedSha, protected_branch: "master", owner: "webhook", marker_path: marker };
    const ctx = await webhook({ isCurrentReleaseFn: (markerSha: string) => markerSha === protectedSha, store: { claimDeploymentAttempt: vi.fn(async () => ({ kind: "busy", attempt })) } }); dirs.push(ctx.dir);
    await writeFile(marker, JSON.stringify({ attemptId: "attempt-current", sha: protectedSha, exitCode: 0, reloadPending: true }));

    await expect(ctx.app.recoverOnBoot()).resolves.toBe(true);

    expect(ctx.store.completeDeploymentAttempt).toHaveBeenCalledWith(null, expect.objectContaining({ attemptId: "attempt-current", state: "succeeded", markerPath: marker }));
    await expect(require("node:fs/promises").access(marker)).rejects.toThrow();
  });

  it("finalizes a failed marker even when the old release is still running", async () => {
    const ctx = await webhook({ isCurrentReleaseFn: () => false }); dirs.push(ctx.dir);
    const marker = join(ctx.dir, "failed.done");
    await writeFile(marker, JSON.stringify({ attemptId: "attempt-1", sha: protectedSha, exitCode: 74 }));

    await ctx.app.finalizeAttempt({ id: "attempt-1", target_sha: protectedSha, owner: "webhook" }, marker);

    expect(ctx.store.completeDeploymentAttempt).toHaveBeenCalledWith(null, expect.objectContaining({ state: "failed", attemptId: "attempt-1" }));
  });

  it("finalizes a recovered marker before considering another launch", async () => {
    const recovered = { id: "attempt-recovered", target_sha: protectedSha, protected_branch: "master", owner: "webhook" };
    const ctx = await webhook({ isCurrentReleaseFn: () => true, store: { claimDeploymentAttempt: vi.fn(async () => ({ kind: "recovered", attempt: recovered })) } }); dirs.push(ctx.dir);
    const marker = join(ctx.dir, "completions", "attempt-recovered.done");
    await writeFile(marker, JSON.stringify({ attemptId: "attempt-recovered", sha: protectedSha, exitCode: 0, reloadPending: true }));

    await ctx.app.recoverOnBoot();

    expect(ctx.spawnFn).not.toHaveBeenCalled();
    expect(ctx.store.completeDeploymentAttempt).toHaveBeenCalledWith(null, expect.objectContaining({ state: "succeeded", markerPath: marker }));
  });

  it("reclaims and polls a recovered live child without spawning a second deploy", async () => {
    const recovered = { id: "attempt-recovered", target_sha: protectedSha, protected_branch: "master", owner: "webhook", child_pid: 12345, marker_path: join(tmpdir(), "not-yet.done") };
    const isAliveFn = vi.fn(() => true);
    const ctx = await webhook({ isAliveFn, store: { claimDeploymentAttempt: vi.fn(async () => ({ kind: "recovered", attempt: recovered })) } }); dirs.push(ctx.dir);

    await ctx.app.recoverOnBoot();

    expect(isAliveFn).toHaveBeenCalledWith(12345);
    expect(ctx.store.renewDeploymentLease).toHaveBeenCalledWith(null, expect.objectContaining({ attemptId: "attempt-recovered", owner: "webhook" }));
    expect(ctx.spawnFn).not.toHaveBeenCalled();
    expect(ctx.store.completeDeploymentAttempt).not.toHaveBeenCalled();
  });

  it("blocks a recovered launch intent without a marker or live PID and never promotes the queue", async () => {
    const recovered = { id: "attempt-intent", target_sha: protectedSha, protected_branch: "master", owner: "webhook", marker_path: join(tmpdir(), "missing.done"), child_pid: null };
    const claimDeploymentAttempt = vi.fn(async () => ({ kind: "recovered", attempt: recovered }));
    const ctx = await webhook({ store: { claimDeploymentAttempt } }); dirs.push(ctx.dir);

    await expect(ctx.app.recoverOnBoot()).resolves.toBe(false);

    expect(ctx.spawnFn).not.toHaveBeenCalled();
    expect(claimDeploymentAttempt).toHaveBeenCalledTimes(1);
    expect(ctx.store.completeDeploymentAttempt).toHaveBeenCalledWith(null, expect.objectContaining({ state: "blocked", recoveryReason: "recovery_launch_intent_without_live_child" }));
  });

  it("leaves a completion marker when the fenced terminal write fails", async () => {
    const ctx = await webhook({ isCurrentReleaseFn: () => true, store: { completeDeploymentAttempt: vi.fn(async () => { throw new Error("database unavailable"); }) } }); dirs.push(ctx.dir);
    const marker = join(ctx.dir, "completion.done");
    await writeFile(marker, JSON.stringify({ attemptId: "attempt-1", sha: protectedSha, exitCode: 0, reloadPending: true }));

    await expect(ctx.app.finalizeAttempt({ id: "attempt-1", target_sha: protectedSha, owner: "webhook" }, marker)).rejects.toThrow("database unavailable");
    await expect(require("node:fs/promises").access(marker)).resolves.toBeUndefined();
  });

  it("blocks a claimed attempt when process spawn fails", async () => {
    const attempt = { id: "attempt-spawn", target_sha: protectedSha, protected_branch: "master", owner: "webhook" };
    const ctx = await webhook({ spawnFn: vi.fn(() => { throw Object.assign(new Error("missing deploy script"), { code: "ENOENT" }); }), store: { claimDeploymentAttempt: vi.fn(async () => ({ kind: "claimed", attempt })) } }); dirs.push(ctx.dir);

    await expect(ctx.app.processNext()).resolves.toBe(false);

    expect(ctx.store.completeDeploymentAttempt).toHaveBeenCalledWith(null, expect.objectContaining({ attemptId: "attempt-spawn", state: "blocked" }));
  });

  it("handles an asynchronous native spawn error before PID validation", async () => {
    const child = Object.assign(new EventEmitter(), { pid: undefined, unref() {} });
    const attempt = { id: "attempt-native-error", target_sha: protectedSha, protected_branch: "master", owner: "webhook" };
    const ctx = await webhook({
      spawnFn: vi.fn(() => { queueMicrotask(() => child.emit("error", Object.assign(new Error("not executable"), { code: "EACCES" }))); return child; }),
      store: { claimDeploymentAttempt: vi.fn(async () => ({ kind: "claimed", attempt })) },
    }); dirs.push(ctx.dir);

    await expect(ctx.app.processNext()).resolves.toBe(false);
    expect(ctx.store.completeDeploymentAttempt).toHaveBeenCalledWith(null, expect.objectContaining({ attemptId: "attempt-native-error", state: "blocked", recoveryReason: "spawn_failed" }));
  });

  it("persists launch intent before spawn and blocks when PID persistence fails", async () => {
    const attempt = { id: "attempt-persist", target_sha: protectedSha, protected_branch: "master", owner: "webhook" };
    const calls: string[] = [];
    const recordDeploymentLaunchIntent = vi.fn(async () => { calls.push("intent"); return {}; });
    const recordDeploymentLaunch = vi.fn(async () => null);
    const ctx = await webhook({
      spawnFn: vi.fn(() => { calls.push("spawn"); return {
        pid: 42,
        stdio: [null, null, null, { end: () => calls.push("release"), destroy: () => calls.push("abort"), unref() {} }],
        kill: () => calls.push("kill"),
        unref() {},
      }; }),
      store: { claimDeploymentAttempt: vi.fn(async () => ({ kind: "claimed", attempt })), recordDeploymentLaunchIntent, recordDeploymentLaunch },
    }); dirs.push(ctx.dir);

    await expect(ctx.app.processNext()).resolves.toBe(false);

    expect(calls).toEqual(["intent", "spawn", "abort", "kill"]);
    expect(ctx.store.completeDeploymentAttempt).toHaveBeenCalledWith(null, expect.objectContaining({ attemptId: "attempt-persist", state: "blocked", recoveryReason: "launch_pid_not_persisted" }));
  });

  it("releases the inherited launch gate only after the child PID is durable", async () => {
    const attempt = { id: "attempt-barrier", target_sha: protectedSha, protected_branch: "master", owner: "webhook" };
    const calls: string[] = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      stdio: [null, null, null, { end: () => calls.push("release"), destroy() {}, unref() {} }],
      unref() {},
    });
    const ctx = await webhook({
      spawnFn: vi.fn(() => { calls.push("spawn"); return child; }),
      store: {
        claimDeploymentAttempt: vi.fn(async () => ({ kind: "claimed", attempt })),
        recordDeploymentLaunchIntent: vi.fn(async () => { calls.push("intent"); return {}; }),
        recordDeploymentLaunch: vi.fn(async () => { calls.push("persist"); return {}; }),
      },
    }); dirs.push(ctx.dir);

    await expect(ctx.app.processNext()).resolves.toBe(true);

    expect(calls).toEqual(["intent", "spawn", "persist", "release"]);
  });

  it("blocks a dead launched child without a marker and does not promote the queue", async () => {
    vi.useFakeTimers();
    try {
      const attempt = { id: "attempt-dead", target_sha: protectedSha, protected_branch: "master", owner: "webhook" };
      const child = Object.assign(new EventEmitter(), {
        pid: 42,
        stdio: [null, null, null, { end() {}, destroy() {}, unref() {} }],
        unref() {},
      });
      const claimDeploymentAttempt = vi.fn(async () => ({ kind: "claimed", attempt }));
      const ctx = await webhook({ spawnFn: vi.fn(() => child), isAliveFn: vi.fn(() => false), store: { claimDeploymentAttempt } }); dirs.push(ctx.dir);

      await ctx.app.processNext();
      await vi.advanceTimersByTimeAsync(500);

      expect(ctx.store.completeDeploymentAttempt).toHaveBeenCalledWith(null, expect.objectContaining({
        attemptId: "attempt-dead", state: "blocked", recoveryReason: "child_exited_without_marker",
      }));
      expect(claimDeploymentAttempt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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
    req.emit("data", Buffer.from("body-secret"));
    req.emit("end");
    await pending;

    expect(res).toMatchObject({ statusCode: 413, body: "webhook_body_too_large", endCalls: 1 });
    expect(ctx.fetchFn).not.toHaveBeenCalled();
    expect(ctx.store.enqueueDeploymentAttempt).not.toHaveBeenCalled();
    expect(ctx.logs).toEqual(["[webhook] request rejected: body too large"]);
    expect(JSON.stringify(ctx.logs)).not.toContain("body-secret");
  });

  it("verifies exact raw bytes when a multibyte character is split across chunks", async () => {
    const ctx = await webhook(); dirs.push(ctx.dir);
    const body = Buffer.from(JSON.stringify({ ref: "refs/heads/master", head_commit: { id: protectedSha }, note: "safe 🚀 payload" }));
    const split = body.indexOf(Buffer.from("🚀")) + 2;
    const req = new EventEmitter() as EventEmitter & { method: string; url: string; headers: Record<string, string> };
    req.method = "POST"; req.url = "/deploy"; req.headers = { "x-hub-signature-256": signature(body), "x-github-event": "push", "x-github-delivery": "split-utf8" };
    const res = response();
    const pending = ctx.app.handleHttp(req, res);
    req.emit("data", body.subarray(0, split));
    req.emit("data", body.subarray(split));
    req.emit("end");
    await pending;

    expect(res).toMatchObject({ statusCode: 202, body: "queued", endCalls: 1 });
  });

  it("accepts a signed body one byte under the limit when data and end are adjacent", async () => {
    const ctx = await webhook(); dirs.push(ctx.dir);
    const base = JSON.stringify({ ref: "refs/heads/master", head_commit: { id: protectedSha }, padding: "" });
    const body = Buffer.from(base.slice(0, -2) + "x".repeat(1024 * 1024 - 1 - Buffer.byteLength(base)) + '"}');
    expect(body).toHaveLength(1024 * 1024 - 1);
    const req = new EventEmitter() as EventEmitter & { method: string; url: string; headers: Record<string, string> };
    req.method = "POST"; req.url = "/deploy"; req.headers = { "x-hub-signature-256": signature(body), "x-github-event": "push", "x-github-delivery": "under-limit" };
    const res = response();
    const pending = ctx.app.handleHttp(req, res);
    req.emit("data", body.subarray(0, body.length - 1));
    req.emit("data", body.subarray(-1));
    req.emit("end");
    await pending;

    expect(res).toMatchObject({ statusCode: 202, body: "queued", endCalls: 1 });
  });

  it("records bounded notification outcomes without leaking secrets", async () => {
    const ctx = await webhook({ fetchFn: vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, text: async () => "provider response body" })
      .mockRejectedValueOnce(new Error("network recipient-secret notify-secret")) }); dirs.push(ctx.dir);

    await expect(ctx.app.sendNotification("deployed")).resolves.toEqual({ status: "accepted", errorCode: null });
    await expect(ctx.app.sendNotification("deployed")).resolves.toEqual({ status: "failed_http", errorCode: "http_unknown" });
    await expect(ctx.app.sendNotification("deployed")).resolves.toEqual({ status: "failed_network", errorCode: "network_error" });
    await expect(ctx.app.sendNotification("deployed", { url: "", secret: "", phone: "" })).resolves.toEqual({ status: "disabled_config", errorCode: "missing_config" });
    expect(JSON.stringify(ctx.logs)).not.toMatch(/recipient-secret|notify-secret|provider response body|network recipient-secret/);
  });

  it("persists notification outcome before removing the completion marker", async () => {
    const order: string[] = [];
    const completeDeploymentAttempt = vi.fn(async () => { order.push("complete"); return {}; });
    const ctx = await webhook({
      fetchFn: vi.fn(async () => { order.push("notify"); return { ok: false, status: 503 }; }),
      store: { completeDeploymentAttempt },
    }); dirs.push(ctx.dir);
    const marker = join(ctx.dir, "failed-notified.done");
    await writeFile(marker, JSON.stringify({ attemptId: "attempt-1", sha: protectedSha, exitCode: 74 }));

    await ctx.app.finalizeAttempt({ id: "attempt-1", target_sha: protectedSha, owner: "webhook" }, marker);

    expect(order).toEqual(["notify", "complete"]);
    expect(completeDeploymentAttempt).toHaveBeenCalledWith(null, expect.objectContaining({
      notificationStatus: "failed_http", notificationErrorCode: "http_503",
    }));
    await expect(require("node:fs/promises").access(marker)).rejects.toThrow();
  });
});
