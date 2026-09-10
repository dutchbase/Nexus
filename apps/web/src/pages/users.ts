import { pool } from "@dcc/database";
import type { Session } from "../session.ts";
import { listReporters } from "../reporter-users.ts";
import { escapeHtml } from "../ui.ts";

export async function render(url: URL, session: Session, _counts: Record<string, number>) {
  if (url.pathname !== "/admin/users") return null;
  const [users, projects] = await Promise.all([
    listReporters(session),
    pool.query("SELECT id,name FROM projects ORDER BY name").then((result) => result.rows),
  ]);
  const checks = (selected: string[] = []) => projects.map((project) =>
    `<label><input type="checkbox" name="project_ids" value="${escapeHtml(project.id)}"${selected.includes(project.id) ? " checked" : ""}>${escapeHtml(project.name)}</label>`,
  ).join("") || "<p>No projects are available. An account with no assigned projects cannot see or submit tickets.</p>";
  const rows = users.map((user) => `<article class="panel" data-user="${escapeHtml(user.id)}">
    <div class="section-head"><div><h2>${escapeHtml(user.username)}</h2><p>${user.is_active ? "Active" : "Inactive"}</p></div>
      <div>${user.project_ids.length ? user.project_ids.map((id) => `<span class="badge">${escapeHtml(projects.find((project) => project.id === id)?.name ?? id)}</span>`).join(" ") : "<span>No assigned projects</span>"}</div></div>
    <details><summary class="button">Edit projects</summary><form data-project-form>${checks(user.project_ids)}<p class="error" role="alert"></p><button class="button primary" type="submit">Save projects</button></form></details>
    <div class="actions"><button class="button" type="button" data-reset-password>Reset password</button><button class="button" type="button" data-toggle-active>${user.is_active ? "Deactivate" : "Reactivate"}</button></div>
  </article>`).join("") || "<p>No reporter users yet.</p>";
  const body = `<div class="page-head"><div><span class="eyebrow">Access</span><h1>Users</h1><p>Create reporter accounts and assign the projects whose tickets they can access.</p></div><button class="button primary" type="button" data-add-user>Add user</button></div>
    <section class="stack">${rows}</section>
    <dialog data-user-dialog><form data-user-create>
      <div class="modal-head"><h2>Add user</h2><button class="button" type="button" data-close-user-dialog>Cancel</button></div>
      <label class="field"><span>Username</span><input name="username" required minlength="3" maxlength="80" autocomplete="off"></label>
      <label class="field"><span>Initial password</span><input name="password" type="password" required minlength="12" autocomplete="new-password"></label>
      <fieldset><legend>Projects</legend>${checks()}</fieldset>
      <p>Leaving all projects unchecked creates an account that cannot see or submit tickets.</p>
      <p class="error" role="alert" data-user-error></p>
      <button class="button primary" type="submit">Add user</button>
    </form></dialog>`;
  return { status: 200, title: "Users", body };
}
