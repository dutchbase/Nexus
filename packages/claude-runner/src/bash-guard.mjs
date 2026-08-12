import { realpathSync } from "node:fs";
import path from "node:path";

const DENIAL_MARKER = "DCC_TOOL_DENIED";
const unsafeShellSyntax = /[\n\r\t'"\\`$(){}\[\]*?~!<>;&|#]/;
const safeArgument = /^[A-Za-z0-9@%_.,:=+\/-]+$/;
const namedDccAgents = new Set(["dcc-mechanical", "dcc-implementer", "dcc-repair", "dcc-reviewer"]);
const fileTools = new Set(["Read", "Glob", "Grep", "Edit", "Write"]);

export function allowsBashCommand(command) {
  if (typeof command !== "string" || command.trim() !== command || command === "" || unsafeShellSyntax.test(command)) return false;
  const argv = command.split(" ");
  if (argv.some((argument) => !safeArgument.test(argument))) return false;
  if (argv[0] === "git") return ["status", "diff", "log"].includes(argv[1]);
  return argv[0] === "pnpm" && argv[1] === "exec" && ["vitest", "tsc"].includes(argv[2]);
}

export function allowsAgent(input) {
  return namedDccAgents.has(input?.subagent_type);
}

function canonicalPath(target, cwd) {
  if (typeof target !== "string" || !target) return null;
  let current = path.resolve(cwd, target);
  const missing = [];
  while (true) {
    try { return path.join(realpathSync(current), ...missing); } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function within(target, root) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function allowsFileTool(input, policy) {
  const cwd = canonicalPath(input?.cwd, process.cwd());
  const toolInput = input?.tool_input;
  if (!cwd || !toolInput || !Array.isArray(policy?.readRoots)
    || (typeof policy?.writeRoot !== "string" && !Array.isArray(policy?.writePaths))) return false;
  if ((input.tool_name === "Glob" && (path.isAbsolute(toolInput.pattern ?? "") || String(toolInput.pattern ?? "").split(/[\\/]/).includes("..")))
    || (input.tool_name === "Grep" && String(toolInput.glob ?? "").split(/[\\/]/).includes(".."))) return false;
  const requested = canonicalPath(
    ["Read", "Edit", "Write"].includes(input.tool_name) ? toolInput.file_path : (toolInput.path ?? input.cwd),
    cwd,
  );
  if (!requested) return false;
  const roots = policy.readRoots.map((root) => canonicalPath(root, cwd)).filter(Boolean);
  if (["Edit", "Write"].includes(input.tool_name)) {
    if (Array.isArray(policy.writePaths)) {
      return policy.writePaths
        .map((writePath) => canonicalPath(writePath, cwd))
        .filter(Boolean)
        .some((writePath) => requested === writePath);
    }
    const writeRoot = canonicalPath(policy.writeRoot, cwd);
    return Boolean(writeRoot && within(requested, writeRoot));
  }
  return roots.some((root) => within(requested, root));
}

async function main() {
  let input;
  try {
    let json = "";
    for await (const chunk of process.stdin) json += chunk;
    input = JSON.parse(json);
  } catch {
    input = null;
  }
  let policy;
  try { policy = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8")); } catch { policy = null; }
  const allowed = input?.tool_name === "Agent"
    ? allowsAgent(input.tool_input)
    : input?.tool_name === "Bash"
      ? allowsBashCommand(input.tool_input?.command)
      : fileTools.has(input?.tool_name) && allowsFileTool(input, policy);
  if (allowed) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: input?.tool_name === "Agent"
        ? `${DENIAL_MARKER}: Execution may delegate only to dcc-mechanical, dcc-implementer, dcc-repair or dcc-reviewer.`
        : fileTools.has(input?.tool_name)
          ? `${DENIAL_MARKER}: Execution file tools are confined to the worktree and trusted read-only runtime inputs.`
        : `${DENIAL_MARKER}: Bash is sandboxed. Only "git status|diff|log" and "pnpm exec vitest|tsc" are permitted, and in this environment Git metadata is hidden and dependencies are not installed, so those commands fail too. Do not retry any Bash command — use Read, Glob and Grep, make the file edits, and report verification as "not run".`,
    },
  }));
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
