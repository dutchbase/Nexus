const unsafeShellSyntax = /[\n\r\t'"\\`$(){}\[\]*?~!<>;&|#]/;
const safeArgument = /^[A-Za-z0-9@%_.,:=+\/-]+$/;

export function allowsBashCommand(command) {
  if (typeof command !== "string" || command.trim() !== command || command === "" || unsafeShellSyntax.test(command)) return false;
  const argv = command.split(" ");
  if (argv.some((argument) => !safeArgument.test(argument))) return false;
  if (argv[0] === "git") return ["status", "diff", "log"].includes(argv[1]);
  return argv[0] === "pnpm" && argv[1] === "exec" && ["vitest", "tsc"].includes(argv[2]);
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
  if (allowsBashCommand(input?.tool_input?.command)) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Execution subagents may run only direct git status/diff/log or pnpm exec vitest/tsc commands.",
    },
  }));
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
