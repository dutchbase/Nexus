import { pool } from "../packages/database/src/index.ts";
import { hashPassword } from "../packages/database/src/password.ts";

function value(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const username = value("--username");
const password = value("--password");
const nonInteractive = process.argv.includes("--non-interactive");
if (!nonInteractive || !username || !password) {
  console.error("usage: create-admin.ts --username USER --password PASSWORD --non-interactive");
  process.exitCode = 2;
} else {
  const existing = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
  if (!existing.rowCount) {
    const passwordHash = await hashPassword(password);
    await pool.query(
      `INSERT INTO users (username, password_hash, role, is_active)
       VALUES ($1, $2, 'admin', true)
       ON CONFLICT (username) DO NOTHING`,
      [username, passwordHash],
    );
  }
  console.log(`administrator ${username} is ready`);
}
await pool.end();
