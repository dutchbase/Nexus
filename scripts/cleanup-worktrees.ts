import { access } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.env.DCC_WORKTREE_ROOT ?? "data/worktrees");
try {
  await access(root);
  console.log(`worktree cleanup inspected ${root}; Phase 1 removes nothing`);
} catch {
  console.log(`worktree root does not exist: ${root}`);
}
