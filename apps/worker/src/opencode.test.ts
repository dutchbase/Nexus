import { describe, expect, it } from "vitest";
import { parseOpenCodeEvents, parseOpenCodeFinalUsage, OpenCodeError, deepSeekModelFor, openCodeConfig } from "./opencode.ts";

const line = (obj: unknown) => JSON.stringify(obj);
const textPart = (id: string, text: string) =>
  line({ type: "message.part.updated", sessionID: "ses_abc", properties: { part: { id, type: "text", text } } });

describe("parseOpenCodeEvents", () => {
  it("returns final text per part in order, joined, plus the session id", () => {
    const stdout = [
      textPart("p1", "Working"),
      textPart("p1", "Working on it..."),
      line({ type: "message.part.updated", sessionID: "ses_abc", properties: { part: { id: "p2", type: "tool", tool: "read" } } }),
      textPart("p3", "verdict:\n```json\n{\"verdict\":\"approved\",\"summary\":\"ok\"}\n```"),
      line({ type: "session.idle", sessionID: "ses_abc" }),
    ].join("\n");
    expect(parseOpenCodeEvents(stdout)).toEqual({
      markdown: "Working on it...\n\nverdict:\n```json\n{\"verdict\":\"approved\",\"summary\":\"ok\"}\n```",
      sessionId: "ses_abc",
    });
  });
  it("throws opencode_failed on an error event", () => {
    const stdout = line({ type: "error", sessionID: "ses_x", error: { name: "UnknownError", data: { message: "boom" } } });
    expect(() => parseOpenCodeEvents(stdout)).toThrow(OpenCodeError);
    expect(() => parseOpenCodeEvents(stdout)).toThrow(/boom/);
  });
  it("throws opencode_no_output when no text parts exist", () => {
    expect(() => parseOpenCodeEvents(line({ type: "session.idle" }))).toThrow(OpenCodeError);
  });
  it("ignores unparseable lines", () => {
    expect(parseOpenCodeEvents(["not-json", textPart("p1", "hi")].join("\n")).markdown).toBe("hi");
  });
  it("preserves document order for multiple text parts nested in a single event (FIFO, not LIFO)", () => {
    // A single event whose object contains several nested text parts, in a
    // key order that would come out reversed under a stack-pop (LIFO) walk.
    const event = {
      type: "custom.batch",
      sessionID: "ses_fifo",
      properties: {
        first: { type: "text", id: "a", text: "first" },
        second: { type: "text", id: "b", text: "second" },
        third: { type: "text", id: "c", text: "third" },
      },
    };
    expect(parseOpenCodeEvents(line(event)).markdown).toBe("first\n\nsecond\n\nthird");
  });
  it("does not collide a real numeric-looking id with the anonymous fallback counter", () => {
    // An id-less part arriving first would, under the old `texts.size`
    // fallback, be keyed "0" — the exact key a real id="0" part arriving
    // second would then independently produce, silently overwriting the
    // anonymous part's text instead of keeping both.
    const anon = line({ type: "message.part.updated", sessionID: "ses_x", properties: { part: { type: "text", text: "anonymous" } } });
    const withId0 = line({ type: "message.part.updated", sessionID: "ses_x", properties: { part: { id: "0", type: "text", text: "real id zero" } } });
    expect(parseOpenCodeEvents([anon, withId0].join("\n")).markdown).toBe("anonymous\n\nreal id zero");
  });
});

describe("parseOpenCodeFinalUsage", () => {
  it("normalizes each final step once by part id", () => {
    const step = (id: string) => ({ type: "message.part.updated", properties: { part: {
      id, type: "step-finish", tokens: { input: 100, output: 200, reasoning: 50, cache: { read: 30, write: 40 } },
    } } });

    expect(parseOpenCodeFinalUsage([step("step-1"), step("step-1"), step("step-2")])).toMatchObject({
      inputTokens: 200, outputTokens: 400, reasoningTokens: 100, cacheReadTokens: 60, cacheWriteTokens: 80,
      rawUsage: [step("step-1").properties.part, step("step-2").properties.part],
    });
  });

  it("returns unavailable when final step usage is absent or malformed", () => {
    expect(parseOpenCodeFinalUsage([{ type: "message.part.updated", properties: { part: { id: "step-1", type: "step-finish" } } }])).toBeNull();
    expect(parseOpenCodeFinalUsage([{ type: "message.part.updated", properties: { part: { id: "step-1", type: "step-finish", tokens: { input: "1", output: 2 } } } }])).toBeNull();
  });
});

describe("deepSeekModelFor", () => {
  it("maps each deepseek model name to its OpenCode CLI model string", () => {
    expect(deepSeekModelFor("deepseek-v4-flash")).toBe("deepseek/deepseek-v4-flash");
    expect(deepSeekModelFor("deepseek-v4-pro")).toBe("deepseek/deepseek-v4-pro");
  });
});

describe("openCodeConfig", () => {
  it("denies mutating tools in read-only mode and allows them in write mode", () => {
    expect((openCodeConfig("read-only") as any).permission)
      .toEqual({ "*": "allow", edit: "deny", bash: "deny", webfetch: "deny" });
    expect((openCodeConfig("write") as any).permission).toEqual({ "*": "allow" });
  });
});

import { mkdtemp, writeFile as writeFileFs, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { invokeOpenCodePlanning, invokeOpenCodeExecution } from "./opencode.ts";

// Stub "opencode" binary: records argv+env+cwd, prints fixture NDJSON events.
async function makeStub(events: unknown[]) {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-stub-"));
  const capturePath = path.join(dir, "capture.json");
  const stubPath = path.join(dir, "opencode-stub.mjs");
  await writeFileFs(stubPath, [
    "#!/usr/bin/env node",
    "import { writeFileSync, readFileSync } from 'node:fs';",
    `const config = JSON.parse(readFileSync(process.env.OPENCODE_CONFIG, 'utf8'));`,
    `writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), config }));`,
    `for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));`,
  ].join("\n"));
  await chmod(stubPath, 0o755);
  return { stubPath, capture: async () => JSON.parse(await readFile(capturePath, "utf8")) };
}

describe("invokeOpenCodePlanning", () => {
  const textEvent = { type: "message.part.updated", sessionID: "ses_test", properties: { part: { id: "p1", type: "text", text: "plan body" } } };

  it("spawns hermetically with read-only config and returns parsed output", async () => {
    const stub = await makeStub([textEvent]);
    const result = await invokeOpenCodePlanning({
      task: "Plan ticket T-1", promptFile: "/tmp/prompt.md", model: "deepseek-v4-flash",
      workingDirectory: tmpdir(), apiKey: "sk-ds", executable: stub.stubPath,
    });
    expect(result).toEqual({ markdown: "plan body", sessionId: "ses_test", exitCode: 0 });
    const captured = await stub.capture();
    // Regression for C1: OpenCode's -f/--file is a yargs array option that
    // greedily consumes the following positional, so the task string MUST
    // come immediately after "run" or it gets parsed as a filename.
    expect(captured.argv).toEqual(["run", "Plan ticket T-1", "--pure", "--format", "json", "-m", "deepseek/deepseek-v4-flash", "-f", "/tmp/prompt.md"]);
    expect(captured.config.permission).toEqual({ "*": "allow", edit: "deny", bash: "deny", webfetch: "deny" });
    expect(captured.env.DEEPSEEK_API_KEY).toBe("sk-ds");
    expect(captured.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(captured.env.GITHUB_TOKEN).toBeUndefined();
    expect(captured.env.XDG_CONFIG_HOME).toBeTruthy();
    expect(captured.cwd).toBe(tmpdir());
  });

  it("throws opencode_failed when the CLI exits non-zero", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "opencode-stub-"));
    const stubPath = path.join(dir, "fail.mjs");
    await writeFileFs(stubPath, "#!/usr/bin/env node\nconsole.error('bad key');\nprocess.exit(2);\n");
    await chmod(stubPath, 0o755);
    await expect(invokeOpenCodePlanning({
      task: "t", promptFile: "/tmp/p.md", model: "deepseek-v4-flash",
      workingDirectory: tmpdir(), apiKey: "k", executable: stubPath,
    })).rejects.toMatchObject({ code: "opencode_failed" });
  });

  it("throws opencode_timeout when the CLI exceeds timeoutMs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "opencode-stub-"));
    const stubPath = path.join(dir, "hang.mjs");
    await writeFileFs(stubPath, "#!/usr/bin/env node\nsetTimeout(() => {}, 60_000);\n");
    await chmod(stubPath, 0o755);
    await expect(invokeOpenCodePlanning({
      task: "t", promptFile: "/tmp/p.md", model: "deepseek-v4-flash",
      workingDirectory: tmpdir(), apiKey: "k", executable: stubPath, timeoutMs: 300,
    })).rejects.toMatchObject({ code: "opencode_timeout" });
  });
});

describe("invokeOpenCodeExecution", () => {
  it("streams events to onEvent, appends raw output to the log, uses write config", async () => {
    const events = [
      { type: "message.part.updated", sessionID: "ses_e", properties: { part: { id: "p1", type: "tool", tool: "bash" } } },
      { type: "message.part.updated", sessionID: "ses_e", properties: { part: { id: "p2", type: "text", text: "done" } } },
      { type: "session.idle", sessionID: "ses_e" },
    ];
    const stub = await makeStub(events);
    const logDir = await mkdtemp(path.join(tmpdir(), "opencode-log-"));
    const logPath = path.join(logDir, "execution.log");
    const seen: Array<{ eventType: string }> = [];
    const result = await invokeOpenCodeExecution({
      task: "Implement the plan", promptFile: "/tmp/p.md", model: "deepseek-v4-pro",
      workingDirectory: tmpdir(), apiKey: "k", executable: stub.stubPath, logPath,
      onEvent: async (event) => { seen.push({ eventType: event.eventType }); },
    });
    expect(result.exitCode).toBe(0);
    expect(seen.map((entry) => entry.eventType))
      .toEqual(["message.part.updated", "message.part.updated", "session.idle"]);
    const captured = await stub.capture();
    // Full-argv assertion (not just the model index) to keep argv order
    // unambiguous — see the C1 regression note in invokeOpenCodePlanning's test.
    expect(captured.argv).toEqual(["run", "Implement the plan", "--pure", "--format", "json", "-m", "deepseek/deepseek-v4-pro", "-f", "/tmp/p.md"]);
    expect(captured.config.permission).toEqual({ "*": "allow" });
    expect(await readFile(logPath, "utf8")).toContain('"session.idle"');
  });

  it("rejects with opencode_failed when the stream contains an error event", async () => {
    const stub = await makeStub([{ type: "error", sessionID: "ses_e", error: { data: { message: "provider exploded" } } }]);
    const logDir = await mkdtemp(path.join(tmpdir(), "opencode-log-"));
    await expect(invokeOpenCodeExecution({
      task: "t", promptFile: "/tmp/p.md", model: "deepseek-v4-flash",
      workingDirectory: tmpdir(), apiKey: "k", executable: stub.stubPath,
      logPath: path.join(logDir, "x.log"), onEvent: async () => undefined,
    })).rejects.toMatchObject({ code: "opencode_failed" });
  });

  it("flushes events and logs on nonzero exit with error event in stream", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "opencode-exit-"));
    const stubPath = path.join(dir, "exit-stub.mjs");
    const events = [
      { type: "message.part.updated", sessionID: "ses_e", properties: { part: { id: "p1", type: "text", text: "partial" } } },
      { type: "error", sessionID: "ses_e", error: { data: { message: "streaming error occurred" } } },
    ];
    await writeFileFs(stubPath, [
      "#!/usr/bin/env node",
      "import { writeFileSync, readFileSync } from 'node:fs';",
      `const config = JSON.parse(readFileSync(process.env.OPENCODE_CONFIG, 'utf8'));`,
      `const capturePath = process.argv[process.argv.length - 1];`,
      `for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));`,
      `writeFileSync(capturePath, 'done');`,
      `process.exit(2);`,
    ].join("\n"));
    await chmod(stubPath, 0o755);
    const logDir = await mkdtemp(path.join(tmpdir(), "opencode-log-"));
    const logPath = path.join(logDir, "execution.log");
    const seen: Array<{ eventType: string }> = [];
    let thrownError: unknown;
    try {
      await invokeOpenCodeExecution({
        task: "t", promptFile: "/tmp/p.md", model: "deepseek-v4-flash",
        workingDirectory: tmpdir(), apiKey: "k", executable: stubPath,
        logPath, onEvent: async (event) => { seen.push({ eventType: event.eventType }); },
      });
    } catch (err) {
      thrownError = err;
    }
    expect(thrownError).toBeInstanceOf(Error);
    expect((thrownError as any).code).toBe("opencode_failed");
    expect((thrownError as Error).message).toMatch(/streaming error occurred/);
    // Verify all events were delivered despite nonzero exit
    expect(seen.map((e) => e.eventType)).toEqual(["message.part.updated", "error"]);
    // Verify log was written
    const logContent = await readFile(logPath, "utf8");
    expect(logContent).toContain('"message.part.updated"');
    expect(logContent).toContain('"error"');
  });

  // I3: worker.ts classifies admin cancels vs. internal timeouts by matching
  // on error.code — the execution path must emit "execution_cancelled" /
  // "execution_timeout" (not the generic "opencode_failed"/"opencode_timeout"
  // used by the read-only planning/pr-review path) or a cancel surfaces as
  // "Execution Failed" instead of "Cancelled".
  it("rejects with execution_timeout when the CLI exceeds timeoutMs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "opencode-hang-"));
    const stubPath = path.join(dir, "hang.mjs");
    await writeFileFs(stubPath, "#!/usr/bin/env node\nsetTimeout(() => {}, 60_000);\n");
    await chmod(stubPath, 0o755);
    const logDir = await mkdtemp(path.join(tmpdir(), "opencode-log-"));
    await expect(invokeOpenCodeExecution({
      task: "t", promptFile: "/tmp/p.md", model: "deepseek-v4-flash",
      workingDirectory: tmpdir(), apiKey: "k", executable: stubPath, timeoutMs: 300,
      logPath: path.join(logDir, "x.log"), onEvent: async () => undefined,
    })).rejects.toMatchObject({ code: "execution_timeout" });
  });

  it("rejects with execution_cancelled when the caller's abort signal fires", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "opencode-hang-"));
    const stubPath = path.join(dir, "hang.mjs");
    await writeFileFs(stubPath, "#!/usr/bin/env node\nsetTimeout(() => {}, 60_000);\n");
    await chmod(stubPath, 0o755);
    const logDir = await mkdtemp(path.join(tmpdir(), "opencode-log-"));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(invokeOpenCodeExecution({
      task: "t", promptFile: "/tmp/p.md", model: "deepseek-v4-flash",
      workingDirectory: tmpdir(), apiKey: "k", executable: stubPath, timeoutMs: 60_000,
      signal: controller.signal,
      logPath: path.join(logDir, "x.log"), onEvent: async () => undefined,
    })).rejects.toMatchObject({ code: "execution_cancelled" });
  });
});
