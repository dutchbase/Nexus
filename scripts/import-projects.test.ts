import { describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "../packages/database/src/migrate.ts";
import { importProjects, normalizeProjectImport } from "./import-projects.ts";

it("merges defaults and maps enabled and agent start path to first-class columns", () => {
  expect(normalizeProjectImport("example", { ai: { model: "sonnet", reasoning_level: "high" } }, {
    name: "Example", enabled: false, agent_start_path: "/tmp",
    paths: { repository: "/srv/example" }, ai: { model: "opus" },
  })).toEqual({
    name: "Example", description: null, repositoryPath: "/srv/example", githubOwner: null,
    githubRepository: null, defaultBranch: "main", enabled: false, agentStartPath: "/tmp",
    configJson: { ai: { model: "opus", reasoning_level: "high" } },
  });
});

const databaseUrl = process.env.DCC_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("project import", () => {
  it("imports effective defaults and lets the material-config trigger bump only real changes", async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate({ connectionString: databaseUrl! });
    const config = {
      defaults: { ai: { model: "sonnet", reasoning_level: "high" } },
      projects: { example: { enabled: false, agent_start_path: "/tmp", paths: { repository: "/srv/example" }, ai: { model: "opus" } } },
    };
    await importProjects(config, client);
    await importProjects(config, client);
    expect((await client.query("SELECT enabled,agent_start_path,config_json,config_version FROM projects WHERE slug='example'")).rows[0])
      .toMatchObject({ enabled: false, agent_start_path: "/tmp", config_json: { ai: { model: "opus", reasoning_level: "high" } }, config_version: 1 });
    config.projects.example.ai.model = "haiku";
    await importProjects(config, client);
    expect((await client.query("SELECT config_version FROM projects WHERE slug='example'")).rows[0].config_version).toBe(2);
    await client.end();
  });
});
