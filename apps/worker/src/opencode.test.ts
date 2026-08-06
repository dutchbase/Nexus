import { describe, expect, it } from "vitest";
import { parseOpenCodeEvents, OpenCodeError, deepSeekModelFor, openCodeConfig } from "./opencode.ts";

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
});

describe("deepSeekModelFor", () => {
  it("maps reasoning levels to deepseek models", () => {
    expect(deepSeekModelFor("low")).toBe("deepseek/deepseek-chat");
    expect(deepSeekModelFor("medium")).toBe("deepseek/deepseek-chat");
    expect(deepSeekModelFor("high")).toBe("deepseek/deepseek-reasoner");
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
      task: "Plan ticket T-1", promptFile: "/tmp/prompt.md", reasoningLevel: "medium",
      workingDirectory: tmpdir(), apiKey: "sk-ds", executable: stub.stubPath,
    });
    expect(result).toEqual({ markdown: "plan body", sessionId: "ses_test", exitCode: 0 });
    const captured = await stub.capture();
    expect(captured.argv).toEqual(["run", "--pure", "--format", "json", "-m", "deepseek/deepseek-chat", "-f", "/tmp/prompt.md", "Plan ticket T-1"]);
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
      task: "t", promptFile: "/tmp/p.md", reasoningLevel: "low",
      workingDirectory: tmpdir(), apiKey: "k", executable: stubPath,
    })).rejects.toMatchObject({ code: "opencode_failed" });
  });

  it("throws opencode_timeout when the CLI exceeds timeoutMs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "opencode-stub-"));
    const stubPath = path.join(dir, "hang.mjs");
    await writeFileFs(stubPath, "#!/usr/bin/env node\nsetTimeout(() => {}, 60_000);\n");
    await chmod(stubPath, 0o755);
    await expect(invokeOpenCodePlanning({
      task: "t", promptFile: "/tmp/p.md", reasoningLevel: "low",
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
      task: "Implement the plan", promptFile: "/tmp/p.md", reasoningLevel: "high",
      workingDirectory: tmpdir(), apiKey: "k", executable: stub.stubPath, logPath,
      onEvent: async (event) => { seen.push({ eventType: event.eventType }); },
    });
    expect(result.exitCode).toBe(0);
    expect(seen.map((entry) => entry.eventType))
      .toEqual(["message.part.updated", "message.part.updated", "session.idle"]);
    const captured = await stub.capture();
    expect(captured.argv[5]).toBe("deepseek/deepseek-reasoner");
    expect(captured.config.permission).toEqual({ "*": "allow" });
    expect(await readFile(logPath, "utf8")).toContain('"session.idle"');
  });

  it("rejects with opencode_failed when the stream contains an error event", async () => {
    const stub = await makeStub([{ type: "error", sessionID: "ses_e", error: { data: { message: "provider exploded" } } }]);
    const logDir = await mkdtemp(path.join(tmpdir(), "opencode-log-"));
    await expect(invokeOpenCodeExecution({
      task: "t", promptFile: "/tmp/p.md", reasoningLevel: "low",
      workingDirectory: tmpdir(), apiKey: "k", executable: stub.stubPath,
      logPath: path.join(logDir, "x.log"), onEvent: async () => undefined,
    })).rejects.toMatchObject({ code: "opencode_failed" });
  });
});
