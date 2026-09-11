import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";

process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/unused";
const databaseUrl = process.env.DCC_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("E2E seed", () => {
  let root: string;
  const client = new pg.Client({ connectionString: databaseUrl });

  beforeAll(async () => {
    const { migrate } = await import("../../../packages/database/src/migrate.ts");
    root = await mkdtemp(join(tmpdir(), "nexus-e2e-seed-"));
    await Promise.all(["va-jobs-platform", "corporate-site", "customer-portal", "billing-api"].map((name) => mkdir(join(root, name))));
    await client.connect();
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate({ connectionString: databaseUrl! });
  }, 60_000);

  afterAll(async () => {
    await client.end();
    await rm(root, { recursive: true, force: true });
  });

  test("loads unchanged fixtures twice after all migrations", () => {
    const env = {
      ...process.env, DATABASE_URL: databaseUrl,
      DCC_DATA_DIR: join(root, "data"),
      FIXTURE_REPO_VA_JOBS_PLATFORM: join(root, "va-jobs-platform"),
      FIXTURE_REPO_CORPORATE_SITE: join(root, "corporate-site"),
      FIXTURE_REPO_CUSTOMER_PORTAL: join(root, "customer-portal"),
      FIXTURE_REPO_BILLING_API: join(root, "billing-api"),
    };
    const seed = join(__dirname, "seed.ts");
    execFileSync(process.execPath, [seed], { env, stdio: "pipe" });
    execFileSync(process.execPath, [seed], { env, stdio: "pipe" });
  });

  test("retains the known fixture identities without duplicates", async () => {
    const projects = (await client.query(
      "SELECT id::text,slug FROM projects WHERE slug=ANY($1::text[]) ORDER BY slug",
      [["va-jobs-platform", "corporate-site", "customer-portal", "billing-api"]],
    )).rows;
    expect(projects).toHaveLength(4);
    expect(projects.find((project) => project.slug === "va-jobs-platform")?.id).toBe("00000000-0000-0000-0000-000000000001");
  });
});
