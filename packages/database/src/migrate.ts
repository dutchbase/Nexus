import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const defaultDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const filenamePattern = /^(\d{3})_[a-z0-9][a-z0-9_-]*\.sql$/;
const advisoryLock = 827618744171;
const legacyAppliedNames: Record<string, string> = {
  "017_project_agent_start_path.sql": "015_project_agent_start_path.sql",
};

export function validateMigrations(names: string[], appliedNames: string[]) {
  const prefixes = new Set<string>();
  const appliedPrefixes = appliedNames.flatMap((name) => {
    const match = filenamePattern.exec(name);
    return match ? [Number(match[1])] : [];
  });
  const appliedMaximum = Math.max(-1, ...appliedPrefixes);
  const applied = new Set(appliedNames);

  for (const name of names) {
    const match = filenamePattern.exec(name);
    if (!match) throw new Error("invalid migration filename " + name);
    if (prefixes.has(match[1])) throw new Error("duplicate migration prefix " + match[1]);
    prefixes.add(match[1]);
    if (!applied.has(name) && !applied.has(legacyAppliedNames[name]) && Number(match[1]) <= appliedMaximum) {
      throw new Error("pending migration prefix " + match[1] + " is not greater than applied maximum " + appliedMaximum);
    }
  }
}

export async function migrate(input: { connectionString?: string; directory?: string } = {}) {
  const connectionString = input.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const directory = input.directory ?? defaultDirectory;
  const names = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  validateMigrations(names, []);

  const client = new pg.Client({ connectionString });
  let locked = false;
  try {
    await client.connect();
    await client.query("SELECT pg_advisory_lock($1)", [advisoryLock]);
    locked = true;
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    await client.query("CREATE TABLE IF NOT EXISTS migration_attempts (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, migration_name text NOT NULL, status text NOT NULL CHECK (status IN ($running$, $applied$, $failed$)), started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, error_text text)");
    const appliedNames = (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((row) => row.name);
    validateMigrations(names, appliedNames);

    for (const name of names) {
      if (appliedNames.includes(name) || appliedNames.includes(legacyAppliedNames[name])) continue;
      const attempt = await client.query<{ id: string }>("INSERT INTO migration_attempts (migration_name,status) VALUES ($1,$running$) RETURNING id", [name]);
      let transactionStarted = false;
      try {
        await client.query("BEGIN");
        transactionStarted = true;
        await client.query(await readFile(join(directory, name), "utf8"));
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
        transactionStarted = false;
        await client.query("UPDATE migration_attempts SET status=$applied$, finished_at=now() WHERE id=$1", [attempt.rows[0].id]);
        console.log("applied " + name);
      } catch (error) {
        if (transactionStarted) await client.query("ROLLBACK");
        await client.query("UPDATE migration_attempts SET status=$failed$, finished_at=now(), error_text=$2 WHERE id=$1", [attempt.rows[0].id, error instanceof Error ? error.message : String(error)]);
        throw error;
      }
    }
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock($1)", [advisoryLock]);
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await migrate();
