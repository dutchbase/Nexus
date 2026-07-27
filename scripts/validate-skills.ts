import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pool } from "../packages/database/src/index.ts";

const skills = (await pool.query("SELECT slug, filesystem_path FROM skills WHERE enabled = true")).rows;
let missing = 0;
for (const skill of skills) {
  try { await access(resolve(skill.filesystem_path)); }
  catch { missing++; console.log(`${skill.slug}: missing ${skill.filesystem_path}`); }
}
await pool.end();
console.log(`validated ${skills.length} skills; ${missing} missing`);
