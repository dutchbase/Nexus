import { spawn } from "node:child_process";
import { forbiddenClaudeAuthVariables } from "../packages/claude-runner/src/auth-guard.ts";

// The web process must never see worker-only credentials (Claude/Anthropic
// auth, GitHub tokens, ...) even in local dev, where both processes are
// spawned from the same parent env.
const webEnv: NodeJS.ProcessEnv = { ...process.env, DCC_PROCESS_ROLE: "web" };
for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "DEEPSEEK_API_KEY", ...forbiddenClaudeAuthVariables]) {
  delete webEnv[name];
}

const children = [
  spawn("pnpm", ["--filter", "web", "dev"], { stdio: "inherit", env: webEnv }),
  spawn("pnpm", ["--filter", "worker", "dev"], { stdio: "inherit", env: { ...process.env, DCC_PROCESS_ROLE: "worker" } }),
];

function stop() {
  for (const child of children) child.kill("SIGTERM");
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const exitCode = await new Promise<number>((resolve) => {
  for (const child of children) {
    child.on("exit", (code) => {
      stop();
      resolve(code ?? 1);
    });
  }
});
process.exitCode = exitCode;
