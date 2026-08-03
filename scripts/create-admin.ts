import { pool } from "../packages/database/src/index.ts";
import { hashPassword, validatePassword } from "../packages/database/src/password.ts";

async function passwordFromStdin() {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteLength = 0;
  let password = "";
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.length;
    if (byteLength > 4096) throw new Error("Password must be 1-4096 UTF-8 bytes without NUL, CR, or LF");
    password += decoder.decode(bytes, { stream: true });
  }
  return password + decoder.decode();
}

const [usernameFlag, username, passwordStdin, nonInteractive] = process.argv.slice(2);
if (usernameFlag !== "--username" || !username || passwordStdin !== "--password-stdin" || nonInteractive !== "--non-interactive") {
  console.error("usage: create-admin.ts --username USER --password-stdin --non-interactive");
  process.exitCode = 2;
} else {
  const password = await passwordFromStdin();
  validatePassword(password);
  const existing = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
  if (!existing.rowCount) {
    const passwordHash = await hashPassword(password);
    await pool.query(
      "INSERT INTO users (username, password_hash, role, is_active) VALUES ($1, $2, 'admin', true) ON CONFLICT (username) DO NOTHING",
      [username, passwordHash],
    );
  }
  console.log("administrator " + username + " is ready");
}
await pool.end();
