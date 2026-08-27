import type pg from "pg";

// Internal to @dcc/domain (deliberately not re-exported from index.ts): callers take
// their pool by injection rather than reaching for the module-global one in
// @dcc/database, so domain logic stays testable against a fake pool.
export async function transaction<T>(db: pg.Pool, work: (client: pg.PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
