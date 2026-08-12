// Tracks stream-json events from a headless Claude execution so the runner can
// distinguish "the session actually finished" from "the process exited 0".
// Claude Code exits 0 even for error_max_turns results (DCC incident: silent
// no-op successes), so exit codes alone are not a success signal.
export const DENIAL_MARKER = "DCC_TOOL_DENIED";

const denialPattern = /permission|denied|not allowed|not permitted/i;

export type ExecutionOutcome = {
  resultSeen: boolean;
  subtype: string | null;
  isError: boolean;
  numTurns: number | null;
  deniedToolCalls: number;
  maxConsecutiveDeniedToolCalls: number;
  reportedDenials: number;
  denialsByTool: Record<string, number>;
};

export type ExecutionVerdict =
  | { code: "execution_max_turns" | "execution_incomplete"; message: string }
  | null;

type AnyEvent = { type?: unknown; message?: { content?: unknown }; subtype?: unknown; is_error?: unknown; num_turns?: unknown; permission_denials?: unknown };

const contentBlocks = (event: AnyEvent): Record<string, unknown>[] => {
  const content = event.message?.content;
  return Array.isArray(content) ? content.filter((block): block is Record<string, unknown> => typeof block === "object" && block !== null) : [];
};

export function createExecutionOutcomeTracker() {
  const toolNamesById = new Map<string, string>();
  const denialsByTool: Record<string, number> = {};
  let resultSeen = false;
  let subtype: string | null = null;
  let isError = false;
  let numTurns: number | null = null;
  let deniedToolCalls = 0;
  let reportedDenials = 0;
  let consecutive = 0;
  let maxConsecutive = 0;

  const recordDenial = (toolName: string) => {
    denialsByTool[toolName] = (denialsByTool[toolName] ?? 0) + 1;
  };

  return {
    observe(raw: unknown): { consecutiveDenials: number } {
      const event = (typeof raw === "object" && raw !== null ? raw : {}) as AnyEvent;
      if (event.type === "assistant") {
        for (const block of contentBlocks(event)) {
          if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
            toolNamesById.set(block.id, block.name);
          }
        }
      } else if (event.type === "user") {
        for (const block of contentBlocks(event)) {
          if (block.type !== "tool_result") continue;
          const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
          if (block.is_error === true && (text.includes(DENIAL_MARKER) || denialPattern.test(text))) {
            deniedToolCalls += 1;
            consecutive += 1;
            maxConsecutive = Math.max(maxConsecutive, consecutive);
            const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
            recordDenial(toolNamesById.get(id) ?? "unknown");
          } else {
            // A real command error or success is progress, not a wall.
            consecutive = 0;
          }
        }
      } else if (event.type === "result") {
        resultSeen = true;
        subtype = typeof event.subtype === "string" ? event.subtype : null;
        isError = event.is_error === true;
        numTurns = typeof event.num_turns === "number" && Number.isSafeInteger(event.num_turns) ? event.num_turns : null;
        if (Array.isArray(event.permission_denials)) {
          reportedDenials = event.permission_denials.length;
          for (const entry of event.permission_denials) {
            const name = typeof (entry as { tool_name?: unknown })?.tool_name === "string" ? (entry as { tool_name: string }).tool_name : "unknown";
            recordDenial(name);
          }
        }
      }
      return { consecutiveDenials: consecutive };
    },
    snapshot(): ExecutionOutcome {
      return {
        resultSeen, subtype, isError, numTurns, deniedToolCalls,
        maxConsecutiveDeniedToolCalls: maxConsecutive, reportedDenials,
        denialsByTool: { ...denialsByTool },
      };
    },
  };
}

export function describeExecutionDenials(outcome: ExecutionOutcome): string {
  const entries = Object.entries(outcome.denialsByTool);
  if (!entries.length) return "No tool denials were recorded.";
  const detail = entries.map(([tool, count]) => `${tool}×${count}`).join(", ");
  return `Denied tool calls: ${detail}.`;
}

export function executionOutcomeVerdict(outcome: ExecutionOutcome): ExecutionVerdict {
  if (!outcome.resultSeen) {
    return { code: "execution_incomplete", message: "Claude execution ended without a final result event; the session did not complete." };
  }
  if (outcome.subtype === "error_max_turns") {
    return {
      code: "execution_max_turns",
      message: `Claude execution exhausted its turn budget after ${outcome.numTurns ?? "?"} turns without finishing. ${describeExecutionDenials(outcome)}`,
    };
  }
  if (outcome.isError || (outcome.subtype !== null && outcome.subtype !== "success")) {
    return {
      code: "execution_incomplete",
      message: `Claude execution reported ${outcome.subtype ?? "an error"} instead of success. ${describeExecutionDenials(outcome)}`,
    };
  }
  return null;
}
