import { spawn } from "node:child_process";

const children = [
  spawn("pnpm", ["--filter", "web", "dev"], { stdio: "inherit", env: { ...process.env, DCC_PROCESS_ROLE: "web" } }),
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
