import { afterAll, beforeAll, expect, test } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let root: string, remote: string, firstSha: string, secondSha: string, featureSha: string, conflictSha: string, port: number, child: ChildProcess;

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port")));
    });
  });
}

async function graphql(query: string, variables: Record<string, unknown>) {
  return fetch(`http://127.0.0.1:${port}/graphql`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }),
  }).then((response) => response.json() as Promise<any>);
}

function api(path: string, body?: unknown) {
  return fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? undefined : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nexus-mock-github-"));
  const work = join(root, "work");
  remote = join(root, "widgets.git");
  execFileSync("git", ["init", "-q", "-b", "production", work]);
  git(work, "config", "user.name", "Nexus Test");
  git(work, "config", "user.email", "nexus@example.invalid");
  await writeFile(join(work, "fixture.txt"), "first\n");
  git(work, "add", "."); git(work, "commit", "-q", "-m", "first"); firstSha = git(work, "rev-parse", "HEAD");
  await writeFile(join(work, "fixture.txt"), "second\n");
  git(work, "commit", "-qam", "second"); secondSha = git(work, "rev-parse", "HEAD");
  git(work, "reset", "--hard", firstSha);
  git(work, "checkout", "-qb", "feature", firstSha);
  await writeFile(join(work, "feature.txt"), "feature\n");
  git(work, "add", "."); git(work, "commit", "-q", "-m", "feature"); featureSha = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "-qb", "conflict", firstSha);
  await writeFile(join(work, "fixture.txt"), "conflict\n");
  git(work, "commit", "-qam", "conflict"); conflictSha = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "-q", "production");
  execFileSync("git", ["clone", "-q", "--bare", work, remote]);
  port = await freePort();
  child = spawn(process.execPath, [join(__dirname, "server.js")], {
    env: { ...process.env, MOCK_GITHUB_PORT: String(port), FIXTURE_REMOTE_WIDGETS: remote }, stdio: "ignore",
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await fetch(`http://127.0.0.1:${port}/repos/acme/widgets`).then((r) => r.ok).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("mock GitHub server did not start");
});

afterAll(async () => {
  child?.kill("SIGTERM");
  await rm(root, { recursive: true, force: true });
});

test("models ruleset absence and atomic GraphQL reference updates", async () => {
  await expect(fetch(`http://127.0.0.1:${port}/repos/acme/widgets/rules/branches/production`).then((r) => r.json())).resolves.toEqual([]);
  const repository = await graphql("query { repository { id } }", { owner: "acme", repository: "widgets" });
  const variables = { repositoryId: repository.data.repository.id, refUpdates: [{ name: "refs/heads/production", beforeOid: firstSha, afterOid: secondSha, force: true }] };
  await expect(graphql("mutation { updateRefs { clientMutationId } }", variables)).resolves.toEqual({ data: { updateRefs: { clientMutationId: null } } });
  expect(git(remote, "rev-parse", "refs/heads/production")).toBe(secondSha);

  const moved = await graphql("mutation { updateRefs { clientMutationId } }", variables);
  expect(moved.errors?.[0]?.message).toMatch(/no longer matches/i);
  expect(git(remote, "rev-parse", "refs/heads/production")).toBe(secondSha);
});

test("models zero-OID create/delete and rejects a multi-ref CAS atomically", async () => {
  const repository = await graphql("query { repository { id } }", { owner: "acme", repository: "widgets" });
  const repositoryId = repository.data.repository.id;
  const zero = "0".repeat(40);

  await expect(graphql("mutation { updateRefs { clientMutationId } }", {
    repositoryId,
    refUpdates: [{ name: "refs/heads/temporary", beforeOid: zero, afterOid: firstSha, force: true }],
  })).resolves.toEqual({ data: { updateRefs: { clientMutationId: null } } });
  expect(git(remote, "rev-parse", "refs/heads/temporary")).toBe(firstSha);

  const refused = await graphql("mutation { updateRefs { clientMutationId } }", {
    repositoryId,
    refUpdates: [
      { name: "refs/heads/production", beforeOid: secondSha, afterOid: firstSha, force: true },
      { name: "refs/heads/temporary", beforeOid: secondSha, afterOid: secondSha, force: true },
    ],
  });
  expect(refused.errors?.[0]?.message).toMatch(/no longer matches/i);
  expect(git(remote, "rev-parse", "refs/heads/production")).toBe(secondSha);
  expect(git(remote, "rev-parse", "refs/heads/temporary")).toBe(firstSha);

  await expect(graphql("mutation { updateRefs { clientMutationId } }", {
    repositoryId,
    refUpdates: [{ name: "refs/heads/temporary", beforeOid: firstSha, afterOid: zero, force: true }],
  })).resolves.toEqual({ data: { updateRefs: { clientMutationId: null } } });
  expect(() => execFileSync("git", ["-C", remote, "rev-parse", "--verify", "refs/heads/temporary"], { stdio: "ignore" })).toThrow();
});

test("prepares a pinned merge on a nested temporary ref before atomic publication", async () => {
  git(remote, "update-ref", "refs/heads/production", secondSha);
  const repository = await graphql("query { repository { id } }", { owner: "acme", repository: "widgets" });
  const repositoryId = repository.data.repository.id;
  const temporary = "nexus/merge-browser-test";
  const zero = "0".repeat(40);
  await graphql("mutation { updateRefs { clientMutationId } }", {
    repositoryId,
    refUpdates: [{ name: `refs/heads/${temporary}`, beforeOid: zero, afterOid: secondSha, force: false }],
  });

  const before = await api(`/repos/acme/widgets/commits/${encodeURIComponent(temporary)}`).then((response) => response.json() as Promise<any>);
  expect(before.sha).toBe(secondSha);
  const mergedResponse = await api("/repos/acme/widgets/merges", { base: temporary, head: featureSha });
  expect(mergedResponse.status).toBe(201);
  const merged = await mergedResponse.json() as any;
  expect(git(remote, "rev-parse", `refs/heads/${temporary}`)).toBe(merged.sha);
  await expect(api(`/repos/acme/widgets/commits/${encodeURIComponent(temporary)}`).then((response) => response.json()))
    .resolves.toMatchObject({ sha: merged.sha });
  expect(git(remote, "show", "-s", "--format=%P", merged.sha).split(" ")).toEqual([secondSha, featureSha]);
  await expect(api("/repos/acme/widgets/merges", { base: temporary, head: featureSha }).then((response) => response.status)).resolves.toBe(204);

  await expect(graphql("mutation { updateRefs { clientMutationId } }", {
    repositoryId,
    refUpdates: [
      { name: "refs/heads/production", beforeOid: secondSha, afterOid: merged.sha, force: false },
      { name: "refs/heads/feature", beforeOid: featureSha, afterOid: featureSha, force: false },
      { name: `refs/heads/${temporary}`, beforeOid: merged.sha, afterOid: zero, force: false },
    ],
  })).resolves.toEqual({ data: { updateRefs: { clientMutationId: null } } });
  expect(git(remote, "rev-parse", "refs/heads/production")).toBe(merged.sha);
  expect(() => execFileSync("git", ["-C", remote, "rev-parse", "--verify", `refs/heads/${temporary}`], { stdio: "ignore" })).toThrow();
});

test("reports a conflicting temporary-branch merge without moving the ref", async () => {
  const repository = await graphql("query { repository { id } }", { owner: "acme", repository: "widgets" });
  const repositoryId = repository.data.repository.id;
  const temporary = "nexus/merge-conflict-test";
  const zero = "0".repeat(40);
  await graphql("mutation { updateRefs { clientMutationId } }", {
    repositoryId,
    refUpdates: [{ name: `refs/heads/${temporary}`, beforeOid: zero, afterOid: secondSha, force: false }],
  });

  const response = await api("/repos/acme/widgets/merges", { base: temporary, head: conflictSha });
  expect(response.status).toBe(409);
  expect(git(remote, "rev-parse", `refs/heads/${temporary}`)).toBe(secondSha);

  await graphql("mutation { updateRefs { clientMutationId } }", {
    repositoryId,
    refUpdates: [{ name: `refs/heads/${temporary}`, beforeOid: secondSha, afterOid: zero, force: false }],
  });
});
