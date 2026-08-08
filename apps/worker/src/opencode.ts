// Second AI engine: runs phases through the OpenCode CLI headless
// (https://opencode.ai/docs/cli/). `opencode run --format json` emits NDJSON
// events on stdout. Mirrors claude-runner's spawn pattern; worker-local
// because the worker is the only consumer.
import { spawn } from "node:child_process";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AiUsage } from "@dcc/domain";

export class OpenCodeError extends Error {
  constructor(message: string, readonly code: string, public usage?: AiUsage) {
    super(message);
  }
}

export function deepSeekModelFor(model: string): string {
  return model === "deepseek-v4-pro" ? "deepseek/deepseek-v4-pro" : "deepseek/deepseek-v4-flash";
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

// ponytail: OpenCode's -f/--file is a yargs array option that greedily
// consumes the following positional — the task string MUST come immediately
// after "run" or it gets parsed as a filename ("Error: File not found:
// <task>"), verified against the real binary.
function openCodeArgs(task: string, model: string, promptFile: string): string[] {
  return ["run", task, "--pure", "--format", "json", "-m", model, "-f", promptFile];
}

function extractEvent(rawLine: string): any | null {
  const trimmed = rawLine.trim();
  if (!trimmed.startsWith("{")) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// A final step is emitted as an update, sometimes more than once. Keep the
// final update per stable part id, then aggregate the provider-reported steps.
export function parseOpenCodeFinalUsage(events: readonly unknown[]): AiUsage | null {
  const steps = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    const part = (event as any)?.properties?.part;
    if (part?.type === "step-finish") {
      if (typeof part.id !== "string" || !part.id) return null;
      steps.set(part.id, part);
    }
  }
  if (!steps.size) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let hasReasoning = false;
  let hasCacheRead = false;
  let hasCacheWrite = false;
  for (const part of steps.values()) {
    const tokens = part.tokens;
    if (!tokens || typeof tokens !== "object") return null;
    const raw = tokens as Record<string, unknown>;
    const input = tokenCount(raw.input);
    const output = tokenCount(raw.output);
    const reasoning = raw.reasoning === undefined ? undefined : tokenCount(raw.reasoning);
    const cache = raw.cache;
    if (cache !== undefined && (!cache || typeof cache !== "object" || Array.isArray(cache))) return null;
    const cacheRead = cache && (cache as Record<string, unknown>).read !== undefined
      ? tokenCount((cache as Record<string, unknown>).read) : undefined;
    const cacheWrite = cache && (cache as Record<string, unknown>).write !== undefined
      ? tokenCount((cache as Record<string, unknown>).write) : undefined;
    if (input === null || output === null || reasoning === null || cacheRead === null || cacheWrite === null
      || (reasoning !== undefined && reasoning > output)) return null;
    inputTokens += input;
    outputTokens += output;
    if (reasoning !== undefined) { reasoningTokens += reasoning; hasReasoning = true; }
    if (cacheRead !== undefined) { cacheReadTokens += cacheRead; hasCacheRead = true; }
    if (cacheWrite !== undefined) { cacheWriteTokens += cacheWrite; hasCacheWrite = true; }
  }
  return {
    inputTokens, outputTokens,
    ...(hasReasoning ? { reasoningTokens } : {}),
    ...(hasCacheRead ? { cacheReadTokens } : {}),
    ...(hasCacheWrite ? { cacheWriteTokens } : {}),
    rawUsage: [...steps.values()],
  };
}

// ponytail: schema-tolerant deep scan for {type:"text", text} parts instead of
// pinning exact event names — opencode's event schema is versioned with the
// CLI; the fixtures in opencode.test.ts document the shape we observed.
export function parseOpenCodeEvents(stdout: string): { markdown: string; sessionId: string | null } {
  const texts = new Map<string, string>();
  let sessionId: string | null = null;
  let anonCounter = 0;
  for (const rawLine of stdout.split("\n")) {
    const event = extractEvent(rawLine);
    if (!event) continue;
    if (typeof event.sessionID === "string" && !sessionId) sessionId = event.sessionID;
    if (event.type === "error") {
      const message = event.error?.data?.message ?? event.error?.name ?? "unknown OpenCode error";
      throw new OpenCodeError(`OpenCode reported an error: ${message}`, "opencode_failed");
    }
    // FIFO traversal (not a LIFO stack-pop) so multi-text-part ordering within
    // one event preserves document order.
    const queue = [event];
    let head = 0;
    while (head < queue.length) {
      const node = queue[head++];
      if (!node || typeof node !== "object") continue;
      if (node.type === "text" && typeof node.text === "string") {
        // A real node.id could coincidentally collide with a counter value
        // (e.g. id "0"); use a namespaced fallback key instead.
        texts.set(node.id !== undefined && node.id !== null ? String(node.id) : `__anon_${anonCounter++}`, node.text);
        continue;
      }
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") queue.push(value);
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
  // Codes to use when termination is attributable to the caller's abort
  // signal vs. our own internal timeout. Defaults preserve the pre-existing
  // (execution-taxonomy-agnostic) behavior used by read-only invocations;
  // the execution entry point overrides these to the codes worker.ts's
  // cancel/timeout classification understands.
  cancelledErrorCode?: string;
  timeoutErrorCode?: string;
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
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: string) => { stdout += chunk; input.onStdoutChunk?.(chunk); });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const bufferedUsage = () => parseOpenCodeFinalUsage(stdout.split("\n").map(extractEvent).filter(Boolean)) ?? undefined;
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
    if (combined.aborted) onAbort();
    const timeoutErrorCode = input.timeoutErrorCode ?? "opencode_timeout";
    const cancelledErrorCode = input.cancelledErrorCode ?? "opencode_failed";
    const exitCode = await new Promise<number>((resolve, reject) => {
      const timedOutNotCancelled = () => timeout.aborted && !input.signal?.aborted;
      const callerCancelled = () => !timeout.aborted && !!input.signal?.aborted;
      const settle = (fn: () => void) => {
        if (killTimer) clearTimeout(killTimer);
        combined.removeEventListener("abort", onAbort);
        fn();
      };
      child.on("error", (error: NodeJS.ErrnoException) => {
        settle(() => reject(timedOutNotCancelled()
          ? new OpenCodeError(`OpenCode timed out after ${timeoutMs}ms`, timeoutErrorCode, bufferedUsage())
          : callerCancelled()
            ? new OpenCodeError(`OpenCode was cancelled: ${error.message}`, cancelledErrorCode, bufferedUsage())
            : new OpenCodeError(`failed to launch OpenCode: ${error.message}`, "opencode_failed", bufferedUsage())));
      });
      child.on("close", (code, killSignal) => {
        settle(() => {
          if (timedOutNotCancelled()) {
            reject(new OpenCodeError(`OpenCode timed out after ${timeoutMs}ms`, timeoutErrorCode, bufferedUsage()));
          } else if (callerCancelled()) {
            reject(new OpenCodeError("OpenCode was cancelled", cancelledErrorCode, bufferedUsage()));
          } else if (killSignal || code === null) {
            reject(new OpenCodeError(`OpenCode terminated by signal ${killSignal}`, "opencode_failed", bufferedUsage()));
          } else {
            resolve(code);
          }
        });
      });
    });
    if (exitCode !== 0) {
      throw new OpenCodeError(
        `OpenCode exited with code ${exitCode}: ${stderr.trim().slice(0, 500) || "no stderr"}`, "opencode_failed", bufferedUsage());
    }
    return { exitCode, stdout, stderr };
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

export async function invokeOpenCodePlanning(input: {
  task: string;
  promptFile: string;
  model: string;
  workingDirectory: string;
  apiKey: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  executable?: string;
}): Promise<{ markdown: string; sessionId: string | null; exitCode: number; usage?: AiUsage }> {
  const result = await runOpenCode({
    args: openCodeArgs(input.task, deepSeekModelFor(input.model), input.promptFile),
    mode: "read-only",
    workingDirectory: input.workingDirectory,
    apiKey: input.apiKey,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    executable: input.executable,
  });
  const usage = parseOpenCodeFinalUsage(result.stdout.split("\n").map(extractEvent).filter(Boolean));
  try {
    return { ...parseOpenCodeEvents(result.stdout), exitCode: result.exitCode, ...(usage ? { usage } : {}) };
  } catch (error) {
    if (usage && error instanceof OpenCodeError) error.usage = usage;
    throw error;
  }
}

export async function invokeOpenCodeExecution(input: {
  task: string;
  promptFile: string;
  model: string;
  workingDirectory: string;
  apiKey: string;
  logPath: string;
  onEvent: (event: { eventType: string; event: unknown; raw: string }) => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  executable?: string;
}): Promise<{ exitCode: number; stderr: string; usage?: AiUsage }> {
  let buffered = "";
  let streamError: OpenCodeError | null = null;
  const usageEvents: unknown[] = [];
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
      usageEvents.push(event);
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
      args: openCodeArgs(input.task, deepSeekModelFor(input.model), input.promptFile),
      mode: "write",
      workingDirectory: input.workingDirectory,
      apiKey: input.apiKey,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      executable: input.executable,
      onStdoutChunk: handleChunk,
      // worker.ts's cancel/timeout classification for the execution path
      // matches on these exact codes (mirrors ClaudeExecutionError's code
      // taxonomy) so admin cancels and timeouts don't surface as generic
      // "opencode_failed" -> Execution Failed.
      cancelledErrorCode: "execution_cancelled",
      timeoutErrorCode: "execution_timeout",
    });
  } catch (err) {
    caught = err;
  } finally {
    // Flush any final buffered line and await both chains in all exit paths
    if (buffered.trim()) {
      const event = extractEvent(buffered);
      if (event) {
        usageEvents.push(event);
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
  const usage = parseOpenCodeFinalUsage(usageEvents);
  // Prefer streamError over generic exit error; otherwise throw caught exception.
  if (streamError) {
    if (usage) streamError.usage = usage;
    throw streamError;
  }
  if (caught) {
    if (usage && caught instanceof OpenCodeError) caught.usage ??= usage;
    throw caught;
  }
  return { exitCode: result!.exitCode, stderr: result!.stderr, ...(usage ? { usage } : {}) };
}
