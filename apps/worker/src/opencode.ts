// Second AI engine: runs phases through the OpenCode CLI headless
// (https://opencode.ai/docs/cli/). `opencode run --format json` emits NDJSON
// events on stdout. Mirrors claude-runner's spawn pattern; worker-local
// because the worker is the only consumer.
import { spawn } from "node:child_process";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export class OpenCodeError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

export function deepSeekModelFor(reasoningLevel: string): string {
  return reasoningLevel === "high" ? "deepseek/deepseek-reasoner" : "deepseek/deepseek-chat";
}

export function openCodeConfig(mode: "read-only" | "write") {
  return {
    $schema: "https://opencode.ai/config.json",
    permission: mode === "read-only"
      ? { "*": "allow", edit: "deny", bash: "deny", webfetch: "deny" }
      // ponytail: write mode is bash-allowed and unsandboxed by explicit user
      // decision — OpenCode has no Claude-style sandbox/network policy.
      // Upgrade path: wrap the spawn in the bwrap machinery from
      // claude-runner's scopedBwrapLaunch if containment is wanted later.
      : { "*": "allow" },
  };
}

export function extractEvent(rawLine: string): any | null {
  const trimmed = rawLine.trim();
  if (!trimmed.startsWith("{")) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

// ponytail: schema-tolerant deep scan for {type:"text", text} parts instead of
// pinning exact event names — opencode's event schema is versioned with the
// CLI; the fixtures in opencode.test.ts document the shape we observed.
export function parseOpenCodeEvents(stdout: string): { markdown: string; sessionId: string | null } {
  const texts = new Map<string, string>();
  let sessionId: string | null = null;
  for (const rawLine of stdout.split("\n")) {
    const event = extractEvent(rawLine);
    if (!event) continue;
    if (typeof event.sessionID === "string" && !sessionId) sessionId = event.sessionID;
    if (event.type === "error") {
      const message = event.error?.data?.message ?? event.error?.name ?? "unknown OpenCode error";
      throw new OpenCodeError(`OpenCode reported an error: ${message}`, "opencode_failed");
    }
    const stack = [event];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      if (node.type === "text" && typeof node.text === "string") {
        texts.set(String(node.id ?? texts.size), node.text);
        continue;
      }
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") stack.push(value);
      }
    }
  }
  const markdown = [...texts.values()].join("\n\n").trim();
  if (!markdown) throw new OpenCodeError("OpenCode produced no output text", "opencode_no_output");
  return { markdown, sessionId };
}

type SpawnResult = { exitCode: number; stdout: string; stderr: string };

async function runOpenCode(input: {
  args: string[];
  mode: "read-only" | "write";
  workingDirectory: string;
  apiKey: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  executable?: string;
  onStdoutChunk?: (chunk: string) => void;
}): Promise<SpawnResult> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "dcc-opencode-"));
  try {
    const configPath = path.join(stateDir, "opencode.json");
    await writeFile(configPath, JSON.stringify(openCodeConfig(input.mode)), { flag: "wx" });
    // Hermetic env: no worker credentials, no user-level opencode config
    // (~/.config/opencode loads personal plugins and MCP servers), no shared
    // session state. Auth comes solely from DEEPSEEK_API_KEY.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DEEPSEEK_API_KEY: input.apiKey,
      OPENCODE_CONFIG: configPath,
      XDG_CONFIG_HOME: path.join(stateDir, "config"),
      XDG_DATA_HOME: path.join(stateDir, "data"),
    };
    const timeoutMs = input.timeoutMs ?? 30 * 60 * 1000;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([timeout, ...(input.signal ? [input.signal] : [])]);
    // Spawn detached (own process group) and do our own SIGTERM->SIGKILL
    // escalation instead of handing `signal` to spawn — Node's built-in
    // signal support only sends a single SIGTERM to the direct child, which
    // leaves a hung/orphaned process behind if the CLI ignores it or has
    // spawned subprocesses of its own. Mirrors packages/claude-runner's
    // terminate() pattern.
    const child = spawn(input.executable ?? process.env.OPENCODE_BIN ?? "opencode", input.args, {
      cwd: input.workingDirectory, env, stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; input.onStdoutChunk?.(String(chunk)); });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const terminate = (killSignal: NodeJS.Signals) => {
      if (!child.pid) return child.kill(killSignal);
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.on("error", () => child.kill(killSignal));
        killer.unref();
        return true;
      }
      try { return process.kill(-child.pid, killSignal); }
      catch { return child.kill(killSignal); }
    };
    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      terminate("SIGTERM");
      killTimer = setTimeout(() => terminate("SIGKILL"), 5_000);
    };
    combined.addEventListener("abort", onAbort, { once: true });
    const exitCode = await new Promise<number>((resolve, reject) => {
      const timedOutNotCancelled = () => timeout.aborted && !input.signal?.aborted;
      const settle = (fn: () => void) => {
        if (killTimer) clearTimeout(killTimer);
        combined.removeEventListener("abort", onAbort);
        fn();
      };
      child.on("error", (error: NodeJS.ErrnoException) => {
        settle(() => reject(timedOutNotCancelled()
          ? new OpenCodeError(`OpenCode timed out after ${timeoutMs}ms`, "opencode_timeout")
          : new OpenCodeError(`failed to launch OpenCode: ${error.message}`, "opencode_failed")));
      });
      child.on("close", (code, killSignal) => {
        settle(() => {
          if (timedOutNotCancelled()) {
            reject(new OpenCodeError(`OpenCode timed out after ${timeoutMs}ms`, "opencode_timeout"));
          } else if (killSignal || code === null) {
            reject(new OpenCodeError(`OpenCode terminated by signal ${killSignal}`, "opencode_failed"));
          } else {
            resolve(code);
          }
        });
      });
    });
    if (exitCode !== 0) {
      throw new OpenCodeError(
        `OpenCode exited with code ${exitCode}: ${stderr.trim().slice(0, 500) || "no stderr"}`, "opencode_failed");
    }
    return { exitCode, stdout, stderr };
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

export async function invokeOpenCodePlanning(input: {
  task: string;
  promptFile: string;
  reasoningLevel: string;
  workingDirectory: string;
  apiKey: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  executable?: string;
}): Promise<{ markdown: string; sessionId: string | null; exitCode: number }> {
  const result = await runOpenCode({
    args: ["run", "--pure", "--format", "json", "-m", deepSeekModelFor(input.reasoningLevel), "-f", input.promptFile, input.task],
    mode: "read-only",
    workingDirectory: input.workingDirectory,
    apiKey: input.apiKey,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    executable: input.executable,
  });
  return { ...parseOpenCodeEvents(result.stdout), exitCode: result.exitCode };
}

export async function invokeOpenCodeExecution(input: {
  task: string;
  promptFile: string;
  reasoningLevel: string;
  workingDirectory: string;
  apiKey: string;
  logPath: string;
  onEvent: (event: { eventType: string; event: unknown; raw: string }) => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  executable?: string;
}): Promise<{ exitCode: number; stderr: string }> {
  let buffered = "";
  let streamError: OpenCodeError | null = null;
  // Serialize onEvent like claude-runner's eventWrites chain: events must land
  // in agent_run_events in order.
  let eventWrites: Promise<void> = Promise.resolve();
  // Serialize log writes to guarantee they land in order (not interleaved).
  let logWrites: Promise<void> = Promise.resolve();
  const handleChunk = (chunk: string) => {
    // Append log writes through the chain to serialize them
    logWrites = logWrites.then(() => appendFile(input.logPath, chunk));
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const rawLine of lines) {
      const event = extractEvent(rawLine);
      if (!event) continue;
      if (event.type === "error" && !streamError) {
        const message = event.error?.data?.message ?? event.error?.name ?? "unknown OpenCode error";
        streamError = new OpenCodeError(`OpenCode reported an error: ${message}`, "opencode_failed");
      }
      eventWrites = eventWrites.then(() =>
        input.onEvent({ eventType: String(event.type ?? "unknown"), event, raw: rawLine }));
    }
  };
  let result: { exitCode: number; stderr: string } | undefined;
  let caught: unknown;
  try {
    result = await runOpenCode({
      args: ["run", "--pure", "--format", "json", "-m", deepSeekModelFor(input.reasoningLevel), "-f", input.promptFile, input.task],
      mode: "write",
      workingDirectory: input.workingDirectory,
      apiKey: input.apiKey,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      executable: input.executable,
      onStdoutChunk: handleChunk,
    });
  } catch (err) {
    caught = err;
  } finally {
    // Flush any final buffered line and await both chains in all exit paths
    if (buffered.trim()) {
      const event = extractEvent(buffered);
      if (event) {
        if (event.type === "error" && !streamError) {
          const message = event.error?.data?.message ?? event.error?.name ?? "unknown OpenCode error";
          streamError = new OpenCodeError(`OpenCode reported an error: ${message}`, "opencode_failed");
        }
        eventWrites = eventWrites.then(() =>
          input.onEvent({ eventType: String(event.type ?? "unknown"), event, raw: buffered }));
      }
      logWrites = logWrites.then(() => appendFile(input.logPath, buffered + "\n"));
    }
    // Wait for all events and log writes to complete before resolving or rejecting
    await eventWrites.catch(() => undefined);
    await logWrites.catch(() => undefined);
  }
  // Prefer streamError over generic exit error; otherwise throw caught exception
  if (streamError) throw streamError;
  if (caught) throw caught;
  return { exitCode: result!.exitCode, stderr: result!.stderr };
}
