import { escapeHtml } from "./shared.ts";
import type { PageResult, Session } from "./shared.ts";
import { pool } from "@dcc/database";

// Dedicated merge workbench: pick a project, pick from/into from the live
// remote branches, and get a pre-flight verdict (up to date / clean /
// conflict / missing) before the merge button ever unlocks. The heavy lifting
// happens in a github.merge_preview worker job; this page only renders state.
export async function render(url: URL, _session: Session, _metrics: Record<string, number>): Promise<PageResult | null> {
  if (url.pathname !== "/admin/merge") return null;
  const projects = (await pool.query(
    `SELECT id, name, default_branch FROM projects
     WHERE github_owner IS NOT NULL AND github_repository IS NOT NULL AND repository_path IS NOT NULL
     ORDER BY name`,
  )).rows;

  const projectOptions = projects.map((project: any) =>
    `<option value="${escapeHtml(project.id)}" data-default-branch="${escapeHtml(project.default_branch ?? "master")}">${escapeHtml(project.name)}</option>`).join("");

  const body = `<div class="eyebrow">Work / merge branches</div><h1>Merge branches</h1>
  <section class="card"><div class="card-body" style="display:flex;flex-direction:column;gap:14px;max-width:640px">
    <label class="field"><span>Project</span>
      <select id="merge-project" ${projects.length ? "" : "disabled"}>
        <option value="">${projects.length ? "Select a project…" : "No GitHub-connected projects configured"}</option>
        ${projectOptions}
      </select>
    </label>
    <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:end">
      <label class="field"><span>From (head)</span><select id="merge-from" disabled><option value="">Select a project first</option></select></label>
      <span style="padding-bottom:10px;color:var(--text3)">→</span>
      <label class="field"><span>Into (base)</span><select id="merge-into" disabled><option value="">Select a project first</option></select></label>
    </div>
    <div style="display:flex;gap:10px;align-items:stretch">
      <div data-merge-status role="status" style="flex:1;border:1px solid var(--border);border-left:3px solid var(--border2);border-radius:5px;padding:11px 14px;font-size:13.5px;color:var(--text2)">
        Select a project to list its branches.
      </div>
      <button class="button" type="button" data-merge-retry hidden>Retry</button>
    </div>
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <button class="button primary" type="button" data-merge-button disabled>Merge</button>
      <button class="button" type="button" data-create-pr-button disabled>Create PR</button>
      <span data-merge-reason style="font-size:13px;color:var(--text3)"></span>
    </div>
  </div></section>
  <section class="card"><div class="card-head">How this works</div><div class="card-body" style="font-size:13px;color:var(--text2)">
    Branches are read live from GitHub via the local clone. Before the buttons
    unlock, a dry-run merge computes whether it would apply cleanly, conflict,
    or is already up to date — each button stays disabled with the reason shown
    whenever its action isn't possible. <strong>Merge</strong> applies head → base
    directly on GitHub (no pull request). <strong>Create PR</strong> opens a pull request
    for the same pair instead — it stays available even when a direct merge
    would conflict or needs review, because GitHub flags those on the PR.
  </div></section>`;
  return { status: 200, title: "Merge branches", body };
}
