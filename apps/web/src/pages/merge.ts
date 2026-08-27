import { escapeHtml } from "./shared.ts";
import type { PageResult, Session } from "./shared.ts";
import { pool } from "@dcc/database";

// Dedicated merge workbench: pick a project, pick from/into from the live
// remote branches, and get a pre-flight verdict (up to date / clean /
// conflict / missing) before the merge button ever unlocks. The heavy lifting
// happens in a github.merge_preview worker job; this page only renders state.
//
// A second top-level tab, Production, hosts the VA Jobs Platform production
// promotion workflow (moving refs/heads/production directly to master via
// updateBranchReference — never a merge commit; see
// packages/domain/src/production-promotion-allowlist.ts for the server-side
// allowlist gating which projects/branches this can ever touch).
export async function render(url: URL, _session: Session, _metrics: Record<string, number>): Promise<PageResult | null> {
  if (url.pathname !== "/admin/merge") return null;
  const projects = (await pool.query(
    `SELECT id, name, default_branch FROM projects
     WHERE github_owner IS NOT NULL AND github_repository IS NOT NULL AND repository_path IS NOT NULL
     ORDER BY name`,
  )).rows;
  const vaJobsPlatform = (await pool.query(`SELECT id, config_json FROM projects WHERE slug='va-jobs-platform'`)).rows[0];

  const projectOptions = projects.map((project: any) =>
    `<option value="${escapeHtml(project.id)}" data-default-branch="${escapeHtml(project.default_branch ?? "master")}">${escapeHtml(project.name)}</option>`).join("");

  const mergeBranchesPanel = `<section class="card"><div class="card-body" style="display:flex;flex-direction:column;gap:14px;max-width:640px">
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

  const productionPanel = vaJobsPlatform ? `
    <div class="tabs" role="tablist">${["VA Jobs Platform"].map((label, index) =>
      `<button type="button" role="tab" id="prod-tab-${index}" aria-controls="prod-panel-${index}" aria-selected="${index === 0}">${label}</button>`).join("")}</div>
    <div role="tabpanel" id="prod-panel-0" aria-labelledby="prod-tab-0">
      <section class="card">
        <div class="card-head">Repository <button class="button" type="button" data-refresh-production-promotion>Refresh</button></div>
        <div class="card-body" data-production-promotion-status data-project-id="${escapeHtml(vaJobsPlatform.id)}">
          <p style="color:var(--text3);font-size:13px">Loading…</p>
        </div>
      </section>
      <section class="card">
        <div class="card-head">Pre-flight</div>
        <div class="card-body" data-production-promotion-preflight>
          <p style="color:var(--text3);font-size:13px">Loading…</p>
        </div>
      </section>
      <section class="card">
        <div class="card-head">Deploy</div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:10px">
          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
            <button class="button primary" type="button" data-production-promote-button disabled>Deploy to production</button>
            <button class="button" type="button" data-production-promote-retry hidden>Retry</button>
            <span data-production-promote-reason style="font-size:13px;color:var(--text3)"></span>
          </div>
        </div>
      </section>
      <section class="card" data-production-diverged-warning hidden>
        <div class="card-head" style="color:var(--t-danger)">Production cannot be fast-forwarded</div>
        <div class="card-body">
          <p>Production has diverged from master and cannot be moved through a normal fast-forward.</p>
          <p>Current production: <code data-diverged-production-sha></code></p>
          <p>Master: <code data-diverged-master-sha></code></p>
          <p>Recovering it will forcibly re-point <code>production</code> to the verified master commit.</p>
          <button class="button danger" type="button" data-production-force-button>Force production to master</button>
        </div>
      </section>
      <section class="card">
        <div class="card-head">Production deployment</div>
        <div data-production-promotion-progress><p style="color:var(--text3);font-size:13px">No deployment in progress.</p></div>
      </section>
      <dialog data-production-promote-dialog>
        <h3>Deploy VA Jobs Platform to production</h3>
        <p><code data-production-promote-dialog-sha></code></p>
        <p data-production-promote-dialog-message></p>
        <p>This commit will become the production version.</p>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="button" type="button" data-production-promote-dialog-cancel>Cancel</button>
          <button class="button primary" type="button" data-production-promote-dialog-confirm>Deploy to production</button>
        </div>
      </dialog>
      <dialog data-production-force-dialog>
        <h3>Force production to master — this cannot be undone</h3>
        <p>Production will be forcibly re-pointed to <code data-production-force-dialog-sha></code>, discarding whatever commit(s) production currently points to that aren't on master.</p>
        <label class="field"><span>Type the target commit's short SHA to confirm</span><input type="text" data-production-force-dialog-input></label>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="button" type="button" data-production-force-dialog-cancel>Cancel</button>
          <button class="button danger" type="button" data-production-force-dialog-confirm disabled>Force production</button>
        </div>
      </dialog>
    </div>` : `<section class="card"><div class="card-body"><p style="color:var(--text3)">VA Jobs Platform is not configured yet — run migration 059.</p></div></section>`;

  const tabLabels = ["Merge branches", "Production"];
  const panelContents = [mergeBranchesPanel, productionPanel];
  const body = `<div class="eyebrow">Work / merge branches</div><h1>Merge branches</h1>
    <div class="tabs" role="tablist">${tabLabels.map((label, index) => `<button type="button" role="tab" id="tab-${index}" aria-controls="panel-${index}" aria-selected="${index === 0}">${label}</button>`).join("")}</div>
    ${panelContents.map((content, index) => `<div role="tabpanel" id="panel-${index}" aria-labelledby="tab-${index}"${index === 0 ? "" : " hidden"}>${content}</div>`).join("")}`;
  return { status: 200, title: "Merge branches", body };
}
