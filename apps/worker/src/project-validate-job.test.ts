import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { runProjectValidateJob } from "./project-validate-job.ts";

const execGit = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function initRepo() {
  const dir = await mkdtemp(join(tmpdir(), "dcc-project-validate-"));
  tempDirs.push(dir);
  await execGit("git", ["init", "-b", "main", dir]);
  await execGit("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  await execGit("git", ["-C", dir, "config", "user.name", "Test"]);
  await execGit("git", ["-C", dir, "remote", "add", "origin", "https://example.invalid/repo.git"]);
  return dir;
}

async function commitFile(dir: string, name: string, content: string) {
  await writeFile(join(dir, name), content);
  await execGit("git", ["-C", dir, "add", name]);
  await execGit("git", ["-C", dir, "commit", "-m", `add ${name}`]);
}

type Query = { text: string; values?: unknown[] };
function db(project: any) {
  const queries: Query[] = [];
  return {
    queries,
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (text.includes("SELECT * FROM projects")) return { rows: [project], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

test("a dirty repo persists categorized file detail, not just the health_status enum", async () => {
  const dir = await initRepo();
  await commitFile(dir, "modified.txt", "original\n");
  await writeFile(join(dir, "modified.txt"), "changed\n");
  await writeFile(join(dir, "untracked.txt"), "new\n");
  const project = { id: "project-1", repository_path: dir, default_branch: "main", agent_start_path: null };
  const database = db(project);

  await runProjectValidateJob({ id: "job-1", payload_json: { project_id: "project-1" } }, database as any).catch(() => {});

  const update = database.queries.find((q) => q.text.includes("health_detail_json=$3"));
  expect(update).toBeDefined();
  expect(update!.values![1]).toBe("repository_dirty");
  const detail = JSON.parse(update!.values![2] as string);
  expect(detail.summary).toEqual({ modified: 1, untracked: 1 });
  expect(detail.files).toContainEqual({ path: "modified.txt", status: "modified", staged: false });
  expect(detail.files).toContainEqual({ path: "untracked.txt", status: "untracked", staged: false });
});

test("an inspection failure (missing path) sets a distinct status, not repository_dirty", async () => {
  const project = { id: "project-2", repository_path: "/nonexistent/dcc-test-" + Date.now(), default_branch: "main", agent_start_path: null };
  const database = db(project);

  await expect(runProjectValidateJob({ id: "job-2", payload_json: { project_id: "project-2" } }, database as any))
    .rejects.toThrow(/repository inspection failed/);

  const update = database.queries.find((q) => q.text.includes("health_status='inspection_error'"));
  expect(update).toBeDefined();
  expect(update!.values![0]).toBe("project-2");
  expect(update!.values![1]).toMatch(/^path_missing:/);
  const dirtyUpdate = database.queries.find((q) => q.text.includes("health_detail_json=$3"));
  expect(dirtyUpdate).toBeUndefined();
});

test("a repository that becomes clean after being dirty clears health_detail_json", async () => {
  const dir = await initRepo();
  await commitFile(dir, "file.txt", "hello\n");
  const project = { id: "project-3", repository_path: dir, default_branch: "main", agent_start_path: null };
  const database = db(project);

  await runProjectValidateJob({ id: "job-3", payload_json: { project_id: "project-3" } }, database as any);

  const update = database.queries.find((q) => q.text.includes("health_detail_json=$3"));
  expect(update).toBeDefined();
  expect(update!.values![1]).toBe("healthy");
  expect(update!.values![2]).toBeNull();
});
