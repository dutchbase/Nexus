# Open-Source Release Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare the `dutchbase/dev-control` repository for public open-source release under the "Nexus" name — README rewrite, LICENSE, CONTRIBUTING.md, issue/PR templates, `.env.example`, config documentation, redaction of private operational details, removal of internal AI-build scaffolding, and GitHub repository metadata — without flipping the repo's visibility to public (that remains an explicit human decision).

**Architecture:** This plan touches only documentation, config-metadata, and repo-hygiene files (`README.md`, `LICENSE`, `CONTRIBUTING.md`, `.github/*`, `.env.example`, `.gitignore`, `package.json` root, `deploy.sh`, `webhook-server.js`, `webhook-runner.sh`, `docs/DEPLOYMENT-RUNBOOK.md`) plus deletion of the internal `.lfd/dcc-build/` tree and `prompts/lfd-dev-control-center.md`. It never touches `apps/web/src/**` (owned by `plans/06-nexus-rebrand-and-visual-refresh.md`), so the two plans can be implemented and merged in either order with zero file conflicts.

**Tech Stack:** Markdown, YAML, `.env` format, GitHub CLI (`gh`), bash. No app code changes.

**Spec:** the "prepare the project for open-source release" section of the user's task brief. See `plans/INDEX.md` for how this plan relates to `plans/06-nexus-rebrand-and-visual-refresh.md`.

## Global Constraints

- The repository is currently **private** on GitHub (`gh repo view dutchbase/dev-control --json isPrivate` → `true`, confirmed by investigation). This plan prepares the repo for public release; it does **not** flip visibility. Flipping to public is a separate, explicit, human-only action taken after reviewing this plan's redaction work (Tasks 4-5 below) — do not run `gh repo edit --visibility public` as part of executing this plan, and flag this clearly in the final PR description.
- Git **history** still contains everything this plan removes from the working tree (the real path `/home/dutchbase/projects/dev-control-center`, the real SSH host alias `vps-nederland`). Removing files from the current tree does not scrub history. Do not attempt a history rewrite (`git filter-repo`, `BFG`, force-push) as part of this plan — flag it as a required human decision before the repo goes public, per the task's own instruction: "do not merely delete them from the latest commit... flag them as requiring rotation and history cleanup."
- No committed secrets were found in the current tree (investigation checked for `.env*` files, PEM/credential/secret-named files, and `ghp_`/`sk-`/`AKIA`/`-----BEGIN...KEY-----` patterns — the only hits were AWS's own public example key `AKIAIOSFODNN7EXAMPLE` inside this repo's own secret-scanner test fixtures). Do not spend time re-auditing this; instead, document the audit's finding in the new README Security section.
- Product name in all new/edited docs is **Nexus**. The actual GitHub repository slug (`dutchbase/dev-control`) is **not** renamed by this plan — renaming a live repo slug is a separate, higher-blast-radius decision (breaks existing clone URLs, CI badges, etc.) that the task brief didn't explicitly request. Where docs need an example clone URL, keep the real slug (`dev-control`), and introduce "Nexus" as the product's display name in prose around it.
- Do not touch `apps/web/src/**`, `apps/worker/src/**`, `packages/**/src/**`, or any test file under those trees — that is `plans/06-nexus-rebrand-and-visual-system.md`'s surface.
- `.gitignore` line 8 is `.env.*` — broad enough to swallow a committed `.env.example` unless negated. Handle this explicitly (Task 2).
- Keep every new doc's tone welcoming and low-friction per the brief — no bureaucratic-sounding contribution requirements, no unnecessarily long templates.

---

### Task 1: Add LICENSE and root package.json metadata

**Files:**
- Create: `LICENSE`
- Modify: `package.json` (root)
- Test: Create `scripts/oss-hygiene.test.ts`

No workspace `package.json` (`apps/web`, `apps/worker`, or any `packages/*`) declares a `license` field today (confirmed by investigation) — so there is nothing to reconcile; adding `"license": "MIT"` only to the root file does not contradict anything downstream.

- [ ] **Step 1: Write the failing test**

Create `scripts/oss-hygiene.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

describe("open-source release hygiene", () => {
  it("has a LICENSE file", () => {
    const license = readFileSync(new URL("LICENSE", root), "utf8");
    expect(license).toContain("MIT License");
  });

  it("root package.json declares license, description, and repository consistent with the LICENSE file", () => {
    const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
    expect(pkg.license).toBe("MIT");
    expect(typeof pkg.description).toBe("string");
    expect(pkg.description.length).toBeGreaterThan(0);
    expect(pkg.repository).toEqual({ type: "git", url: "https://github.com/dutchbase/dev-control.git" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run scripts/oss-hygiene.test.ts --reporter=verbose`
Expected: FAIL — `LICENSE` doesn't exist; `package.json` has no `license`/`description`/`repository` fields.

- [ ] **Step 3: Create LICENSE**

Create `/home/dutchbase/projects/dev-control/LICENSE` (standard MIT text, copyright holder set to the repo owner):
```
MIT License

Copyright (c) 2026 dutchbase

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 4: Update root `package.json`**

Current full content:
```json
{
  "name": "development-control-center",
  "private": true,
  "packageManager": "pnpm@11.17.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx scripts/dev.ts",
    "verify": "tsc --noEmit && vitest run --config vitest.config.ts --reporter=verbose",
    "test:unit": "vitest run --config vitest.config.ts --reporter=verbose",
    "admin:create": "tsx scripts/create-admin.ts",
    "projects:import": "tsx scripts/import-projects.ts",
    "postinstall": "tsx scripts/build-argon2.ts",
    "build:argon2": "tsx scripts/build-argon2.ts"
  },
  "dependencies": {
    "pg": "8.22.0"
  },
  "devDependencies": {
    "@playwright/test": "1.62.0",
    "@types/node": "22.20.1",
    "@types/pg": "8.20.0",
    "tsx": "4.20.3",
    "typescript": "5.8.3",
    "vitest": "2.1.9"
  }
}
```

Replace with (adds `description`, `license`, `repository`, `homepage`, `bugs`; renames `name` for brand consistency — this is the one package-metadata rename this plan performs, kept minimal since it's a private, unpublished root package name with no downstream consumers):
```json
{
  "name": "nexus",
  "description": "Nexus — an open-source control center for software projects, AI-assisted development workflows, pull requests, jobs, and deployments.",
  "private": true,
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/dutchbase/dev-control.git" },
  "homepage": "https://github.com/dutchbase/dev-control#readme",
  "bugs": { "url": "https://github.com/dutchbase/dev-control/issues" },
  "packageManager": "pnpm@11.17.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx scripts/dev.ts",
    "verify": "tsc --noEmit && vitest run --config vitest.config.ts --reporter=verbose",
    "test:unit": "vitest run --config vitest.config.ts --reporter=verbose",
    "admin:create": "tsx scripts/create-admin.ts",
    "projects:import": "tsx scripts/import-projects.ts",
    "postinstall": "tsx scripts/build-argon2.ts",
    "build:argon2": "tsx scripts/build-argon2.ts"
  },
  "dependencies": {
    "pg": "8.22.0"
  },
  "devDependencies": {
    "@playwright/test": "1.62.0",
    "@types/node": "22.20.1",
    "@types/pg": "8.20.0",
    "tsx": "4.20.3",
    "typescript": "5.8.3",
    "vitest": "2.1.9"
  }
}
```
(Sub-package names — `web`, `worker`, `@dcc/*` — are deliberately left unchanged; see Global Constraints in `plans/06-nexus-rebrand-and-visual-system.md`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run scripts/oss-hygiene.test.ts --reporter=verbose`
Expected: PASS (the other two `it()` blocks added in later tasks will still fail — that's expected until those tasks land; run with `-t "LICENSE|license, description"` to scope to just this task's assertions if needed).

- [ ] **Step 6: Commit**

```bash
git add LICENSE package.json scripts/oss-hygiene.test.ts
git commit -m "chore: add MIT LICENSE and package metadata for open-source release"
```

---

### Task 2: `.env.example` + `.gitignore` fix

**Files:**
- Create: `.env.example`
- Modify: `.gitignore:8`
- Test: `scripts/oss-hygiene.test.ts` (extends Task 1's file)

The `.env.example` content below is derived directly from the README's existing "Configure environment" section (`README.md:91-132`, already accurate) plus the full env-var audit performed during investigation (every `process.env.X` in `apps/`/`packages/`/`scripts/` and every `$VAR` in `deploy.sh`/`webhook-server.js`/`webhook-runner.sh`/`scripts/backup.sh`/`scripts/restore-drill.sh`).

- [ ] **Step 1: Write the failing test**

Extend `scripts/oss-hygiene.test.ts`:
```ts
it(".env.example exists, is tracked (not swallowed by .gitignore), and documents every required variable", () => {
  const envExample = readFileSync(new URL(".env.example", root), "utf8");
  for (const required of ["DATABASE_URL", "PORT", "APP_BASE_URL", "GITHUB_TOKEN", "GITHUB_API_BASE_URL", "PROJECTS_CONFIG_PATH", "WEBHOOK_SECRET", "DEPLOY_PROTECTED_BRANCH"]) {
    expect(envExample).toContain(required);
  }
  const gitignore = readFileSync(new URL(".gitignore", root), "utf8");
  const envStarLine = gitignore.split("\n").find((line) => line.trim() === ".env.*");
  expect(envStarLine, ".gitignore must still ignore .env.* (real secrets)").toBeTruthy();
  const negation = gitignore.split("\n").find((line) => line.trim() === "!.env.example");
  expect(negation, ".gitignore must explicitly un-ignore .env.example").toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run scripts/oss-hygiene.test.ts --reporter=verbose`
Expected: FAIL — `.env.example` doesn't exist; no negation line in `.gitignore`.

- [ ] **Step 3: Create `.env.example`**

Create `/home/dutchbase/projects/dev-control/.env.example`:
```bash
# Nexus environment configuration
#
# Nothing in this repo auto-loads .env files — wire this up via systemd's
# EnvironmentFile=, pm2's env config, or `set -a; source .env; set +a` for
# one-off commands. See README.md "Configure environment" for the full guide.
#
# Split into two files in production: `.env` (safe for the web process) and
# `.env.worker` (worker-only credentials — never expose these to the web
# process). This example combines both for a quick local dev setup.

# ---- Required ----
DATABASE_URL=postgresql://nexus:change-me@127.0.0.1:5432/nexus

# ---- Web process ----
PORT=3000                                # apps/web listens here
HOST=0.0.0.0
APP_BASE_URL=http://localhost:3000       # used to build links in notifications; must be HTTPS in production
DCC_TRUST_PROXY_HOPS=1                   # reverse-proxy hop count; use 0 if you're not behind one
NODE_ENV=development
DCC_PROCESS_ROLE=web                     # pnpm dev sets this automatically for local development

# ---- Worker-only credentials (put in .env.worker in production; never in .env) ----
CLAUDE_CODE_OAUTH_TOKEN=                 # required for the worker to run Claude Code executions
GITHUB_TOKEN=                            # PAT or GitHub App installation token with repo push + PR access
GITHUB_API_BASE_URL=https://api.github.com
GHCR_READ_TOKEN=                         # optional: GHCR fallback bearer token for private image pulls

# Optional: enables the deepseek-v4-flash / deepseek-v4-pro models (via OpenCode) for
# PR reviews, planning, execution, repair, and conflict resolution. Jobs resolved to
# either model fail fast with a clear error if this is unset.
DEEPSEEK_API_KEY=

# Optional: absolute path to the OpenCode CLI binary (defaults to "opencode" on PATH).
OPENCODE_BIN=

# ---- Optional overrides (sane defaults if unset) ----
DB_POOL_SIZE=10
DCC_DATA_DIR=./data                      # managed artifact root for web, worker, and reconciliation
DCC_DATA_ROOT=.                          # compatibility fallback: artifacts live in $DCC_DATA_ROOT/data when DCC_DATA_DIR is unset
DCC_SKILLS_ROOT=.                        # worker: where skill definitions are read from
PROJECTS_CONFIG_PATH=./config/projects.yaml

# ---- Deployment webhook (only needed if you use the included deploy.sh/webhook-server.js flow) ----
WEBHOOK_SECRET=                          # HMAC secret GitHub signs push-webhook payloads with
WEBHOOK_PORT=9003
DEPLOY_PROTECTED_BRANCH=master
DCC_ROOT=                                # absolute path to this checkout on the deploy target; no default in Nexus — set explicitly
DCC_DEPLOY_HEALTH_URL=http://127.0.0.1:3000/api/health

# ---- Backups (only needed if you use scripts/backup.sh / scripts/restore-drill.sh) ----
DCC_BACKUP_DIRECTORY=/var/backups/nexus
DCC_BACKUP_RETENTION_DAYS=30
DCC_CONFIG_DIR=./config

# ---- Per-notification-provider secrets, named dynamically ----
# Referenced by config/notification-providers.yaml as DCC_NOTIFICATION_SECRET_<NAME>.
# Example: DCC_NOTIFICATION_SECRET_SLACK=...
```

- [ ] **Step 4: Fix `.gitignore`**

Current line 8:
```
.env.*
```
Insert a negation immediately after it:
```
.env.*
!.env.example
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run scripts/oss-hygiene.test.ts --reporter=verbose`
Expected: PASS.

- [ ] **Step 6: Confirm git actually tracks the file (not just that the test passes on disk)**

Run: `git check-ignore -v .env.example`
Expected: non-zero exit / no output (meaning it is **not** ignored — if this prints a matching rule, the negation didn't take effect and needs to be reordered or fixed before continuing).

- [ ] **Step 7: Commit**

```bash
git add .env.example .gitignore scripts/oss-hygiene.test.ts
git commit -m "chore: add .env.example, un-ignore it from the .env.* gitignore rule"
```

---

### Task 3: CONTRIBUTING.md, pull request template, issue templates

**Files:**
- Create: `CONTRIBUTING.md`
- Create: `.github/PULL_REQUEST_TEMPLATE.md`
- Create: `.github/ISSUE_TEMPLATE/bug_report.md`
- Create: `.github/ISSUE_TEMPLATE/feature_request.md`
- Test: `scripts/oss-hygiene.test.ts` (extends)

Investigation confirmed `.github/` currently contains only `workflows/ci.yml` and `workflows/superpowers-update.yml` — no templates of any kind exist yet.

- [ ] **Step 1: Write the failing test**

Extend `scripts/oss-hygiene.test.ts`:
```ts
import { existsSync } from "node:fs";

it("has contribution docs and GitHub templates", () => {
  expect(existsSync(new URL("CONTRIBUTING.md", root))).toBe(true);
  expect(existsSync(new URL(".github/PULL_REQUEST_TEMPLATE.md", root))).toBe(true);
  expect(existsSync(new URL(".github/ISSUE_TEMPLATE/bug_report.md", root))).toBe(true);
  expect(existsSync(new URL(".github/ISSUE_TEMPLATE/feature_request.md", root))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run scripts/oss-hygiene.test.ts --reporter=verbose`
Expected: FAIL.

- [ ] **Step 3: Create `CONTRIBUTING.md`**

```md
# Contributing to Nexus

Thanks for considering a contribution — Nexus is actively developed and
external contributions are genuinely welcome, from a one-line typo fix to a
new deployment integration.

## Quick start

1. **Fork** the repository and clone your fork.
2. Follow the [README's installation guide](README.md#installation) to get
   Nexus running locally (`pnpm install`, a local Postgres, `pnpm verify`).
3. Create a branch off `master`: `git checkout -b fix/short-description` or
   `feat/short-description`.
4. Make your change.
5. Run the checks before opening a PR:
   ```bash
   pnpm verify   # tsc --noEmit + the full unit test suite
   ```
6. Commit with a clear message (conventional-commit style is preferred but
   not enforced: `fix: ...`, `feat: ...`, `docs: ...`, `chore: ...`).
7. Push your branch and open a pull request against `master`. Fill in the PR
   template — it's short by design.

## What makes a good PR

- **Keep it focused.** One fix or one feature per PR. Unrelated cleanups
  make review slower for everyone — open a separate PR for those.
- **Explain the problem and the solution**, not just the diff. The PR
  template prompts for this.
- **Add or update tests** for behavior you change, following the existing
  pattern in the touched file (this codebase uses Vitest; most `*.ts` files
  have a colocated `*.test.ts`).
- **Never commit secrets.** Check `git diff` before pushing if you've been
  poking at `.env`/config files.
- **Match the existing code style** — this is a plain TypeScript codebase
  with no framework magic; look at neighboring code before introducing a new
  pattern.
- **Preserve backward compatibility** for anything documented in the README
  (env var names, config file schema, CLI script flags) unless the PR is
  explicitly about changing that contract — call it out clearly if so.

Small PRs are genuinely encouraged — you don't need to solve everything in
one pass.

## Where to start

Not sure what to work on? These areas welcome contributions:

- UI/UX improvements to the admin dashboard
- Additional deployment-target integrations (beyond the current PM2 + git-worktree flow)
- Broader GitHub workflow support (GitHub Apps, additional webhook events)
- Support for AI-agent providers beyond Claude Code / OpenCode
- Observability (metrics, structured logging, tracing)
- Test coverage, especially end-to-end (`tests/e2e/`)
- Documentation — setup guides, troubleshooting, architecture notes
- Project-configuration ergonomics (`config/projects.yaml` validation, CLI helpers)

None of the above are promises of a particular roadmap — they're areas where
help is genuinely useful right now.

## Getting help / reporting problems

- **Bugs and feature requests:** [open a GitHub issue](https://github.com/dutchbase/dev-control/issues/new/choose).
- **Code contributions:** open a pull request — see above.
- **Anything else:** reach out on X/Twitter: [@dutchbase](https://x.com/dutchbase).

By contributing, you agree your contributions will be licensed under this
project's [MIT License](LICENSE).
```

- [ ] **Step 4: Create `.github/PULL_REQUEST_TEMPLATE.md`**

```md
## What changed

<!-- Briefly describe the change. -->

## Why

<!-- What problem does this solve, or what does it improve? Link an issue if there is one. -->

## How was this tested

<!-- pnpm verify output, manual steps taken, or new/updated tests added. -->

## Screenshots (if UI change)

<!-- Before/after screenshots or a short recording, if this touches the admin UI, login screen, or public form. -->

## Breaking changes

<!-- Any env var, config schema, or CLI flag changes? If none, write "None". -->

## Related issues

<!-- Closes #... / Relates to #... -->
```

- [ ] **Step 5: Create `.github/ISSUE_TEMPLATE/bug_report.md`**

```md
---
name: Bug report
about: Something isn't working as expected
title: "[Bug] "
labels: bug
---

**Nexus version/commit**
<!-- git rev-parse HEAD, or the commit/tag you're running -->

**Environment**
<!-- OS, Node version, how you're running it (pnpm dev / systemd / Docker / other), Postgres version -->

**Steps to reproduce**
1.
2.
3.

**Expected behavior**


**Actual behavior**


**Logs / errors**
<!-- Paste relevant terminal output, browser console errors, or server logs. Redact secrets. -->

**Screenshots**
<!-- If applicable -->
```

- [ ] **Step 6: Create `.github/ISSUE_TEMPLATE/feature_request.md`**

```md
---
name: Feature request
about: Suggest an idea or improvement
title: "[Feature] "
labels: enhancement
---

**Problem / use case**
<!-- What are you trying to do that Nexus doesn't support today? -->

**Proposed behavior**
<!-- What would you like to see happen? -->

**Alternatives considered**
<!-- Any workarounds you're using now, or other approaches you considered? -->
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm exec vitest run scripts/oss-hygiene.test.ts --reporter=verbose`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add CONTRIBUTING.md .github/PULL_REQUEST_TEMPLATE.md .github/ISSUE_TEMPLATE/
git commit -m "docs: add CONTRIBUTING guide, PR template, and issue templates"
```

---

### Task 4: Redact private operational details from deploy tooling and the runbook

**Files:**
- Modify: `deploy.sh:6`
- Modify: `webhook-server.js:15,23,24`
- Modify: `webhook-runner.sh:3`
- Modify: `docs/DEPLOYMENT-RUNBOOK.md:11-16` (and any other `/home/deploy/projects/dev-control` occurrences in that file)
- Test: `scripts/oss-hygiene.test.ts` (extends)

Investigation found these are the only **live, shipped** files with hardcoded private-looking defaults (as opposed to docs/plans, which Task 6 handles separately). `deploy.sh:6` and `webhook-server.js:23-24` bake this operator's real deployment path in as the *default* fallback value — still overridable via `DCC_ROOT`/env vars today, so changing the default doesn't remove functionality, it just stops encoding one operator's real filesystem layout as the product's default behavior. `docs/DEPLOYMENT-RUNBOOK.md:11` additionally contains a real SSH host alias (`vps-nederland`) and username — the single highest-sensitivity line found in the whole audit.

- [ ] **Step 1: Write the failing test**

Extend `scripts/oss-hygiene.test.ts`:
```ts
it("does not hardcode a private deploy path as the default in shipped deploy tooling", () => {
  for (const file of ["deploy.sh", "webhook-server.js", "webhook-runner.sh"]) {
    const content = readFileSync(new URL(file, root), "utf8");
    expect(content, `${file} should not default to /home/deploy/...`).not.toContain("/home/deploy/");
  }
});

it("does not expose a real SSH host alias in the deployment runbook", () => {
  const runbook = readFileSync(new URL("docs/DEPLOYMENT-RUNBOOK.md", root), "utf8");
  expect(runbook).not.toContain("vps-nederland");
  expect(runbook).not.toContain("/home/deploy/");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run scripts/oss-hygiene.test.ts --reporter=verbose`
Expected: FAIL.

- [ ] **Step 3: Fix `deploy.sh:6`**

Current:
```bash
ROOT="${DCC_ROOT:-/home/deploy/projects/dev-control}"
```
Replace with a generic, still-functional default:
```bash
ROOT="${DCC_ROOT:-/opt/nexus}"
```

- [ ] **Step 4: Fix `webhook-server.js:15,23,24`**

Current (three occurrences of the same literal within `readConfig()`):
```js
const stateDir = env.DEPLOY_STATE_DIR || '/home/deploy/projects/dev-control/.deploy-state';
  return {
    secret: env.WEBHOOK_SECRET,
    port: Number(env.WEBHOOK_PORT || 9003),
    protectedBranch: env.DEPLOY_PROTECTED_BRANCH,
    // Execute the release's own deploy.sh, not the checkout root's: the root
    // working tree only updates when someone pulls, so a stale copy would
    // keep replaying old deploy logic on every future cutover.
    deployShPath: env.DEPLOY_SH_PATH || path.join(env.DCC_ROOT || '/home/deploy/projects/dev-control', '.deploy-current', 'deploy.sh'),
    currentReleaseLink: env.DCC_DEPLOY_CURRENT_LINK || path.join(env.DCC_ROOT || '/home/deploy/projects/dev-control', '.deploy-current'),
```
Replace all three `/home/deploy/projects/dev-control` literals with `/opt/nexus`:
```js
const stateDir = env.DEPLOY_STATE_DIR || '/opt/nexus/.deploy-state';
  return {
    secret: env.WEBHOOK_SECRET,
    port: Number(env.WEBHOOK_PORT || 9003),
    protectedBranch: env.DEPLOY_PROTECTED_BRANCH,
    // Execute the release's own deploy.sh, not the checkout root's: the root
    // working tree only updates when someone pulls, so a stale copy would
    // keep replaying old deploy logic on every future cutover.
    deployShPath: env.DEPLOY_SH_PATH || path.join(env.DCC_ROOT || '/opt/nexus', '.deploy-current', 'deploy.sh'),
    currentReleaseLink: env.DCC_DEPLOY_CURRENT_LINK || path.join(env.DCC_ROOT || '/opt/nexus', '.deploy-current'),
```

- [ ] **Step 5: Fix `webhook-runner.sh:3`**

Read the file first to get its exact current content (it's only 6 lines per investigation), then replace its `BASE_DIR=/home/deploy/projects/dev-control` line with:
```bash
BASE_DIR="${DCC_ROOT:-/opt/nexus}"
```
(Preserve whatever quoting/export style the rest of the file already uses — read the file before editing so the replacement matches surrounding syntax exactly.)

- [ ] **Step 6: Redact `docs/DEPLOYMENT-RUNBOOK.md`**

Read the full file first (it's referenced from the README's "Updating" section). At minimum, replace the header block (around lines 1-16, which currently reads roughly):
```md
Server: `ssh vps-nederland` (user `deploy`). Repo root:
`/home/deploy/projects/dev-control` (a checkout whose `origin/master` tracks
GitHub). Live releases: `/home/deploy/projects/dev-control/.deploy-releases/<sha>`,
selected by the `.deploy-current` symlink. pm2 manages the three processes;
**pm2 lives in the nvm PATH**: prefix commands with
`export PATH=/home/deploy/.nvm/versions/node/v24.16.0/bin:$PATH`.
```
with a genericized version that keeps the operational guidance but drops the real hostname/path:
```md
Server: `ssh <your-deploy-host>` (whatever user your deploy process runs
as). Repo root: `$DCC_ROOT` (defaults to `/opt/nexus` — see `deploy.sh`; a
checkout whose `origin/master` tracks GitHub). Live releases:
`$DCC_ROOT/.deploy-releases/<sha>`, selected by the `.deploy-current`
symlink. pm2 manages the three processes (`dcc-web`, `dcc-worker`,
`dcc-webhook`); if you installed Node via nvm, pm2 may only be on `PATH`
under nvm's shim — prefix commands with
`export PATH=$(dirname "$(nvm which node)"):$PATH` if `pm2` isn't found.
```
Then search the rest of the file for further `/home/deploy/projects/dev-control` occurrences (investigation found this pattern at lines 12, 13, 16, 21, 57, 58, 93, 106) and replace each with `$DCC_ROOT` (or `/opt/nexus` in a plain prose sentence where a shell variable wouldn't read naturally) — read the file fully first so each replacement fits its surrounding sentence.

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm exec vitest run scripts/oss-hygiene.test.ts --reporter=verbose`
Expected: PASS.

- [ ] **Step 8: Manually verify `deploy.sh` still parses correctly**

Run: `bash -n deploy.sh` and `bash -n webhook-runner.sh`
Expected: no syntax errors (this is a static check — actually exercising the deploy flow requires a real target host and is out of scope for this plan).

- [ ] **Step 9: Commit**

```bash
git add deploy.sh webhook-server.js webhook-runner.sh docs/DEPLOYMENT-RUNBOOK.md scripts/oss-hygiene.test.ts
git commit -m "chore: replace hardcoded /home/deploy path and real SSH host alias with generic defaults"
```

---

### Task 5: Remove internal AI-build scaffolding from the tracked repo

**Files:**
- Delete: `.lfd/dcc-build/` (64 tracked files)
- Delete: `prompts/lfd-dev-control-center.md`
- Test: `scripts/oss-hygiene.test.ts` (extends)

Investigation found this entire tree is internal AI-agent build scaffolding used to originally construct this project (`EXECUTION_PROMPT.md`, `FRONTEND_COMPLETION_PROMPT.md`, `LOG.md`, `goal.md`, a `harness/` subtree of mock-Claude/mock-GitHub fixtures and Playwright specs). It:
- References the operator's real absolute home directory (`/home/dutchbase/projects/dev-control-center`) throughout `prompts/lfd-dev-control-center.md` and the `.lfd/dcc-build/*` files.
- Is **not** part of the shipped product — `vitest.config.ts` already excludes `.lfd/**` from the test run, and there is no CI workflow (`ci.yml` or `superpowers-update.yml`) that references it.
- Has no value to an external user or contributor — it documents how this specific instance of the app was originally scaffolded by an AI agent, not how to use or extend Nexus.

Removing it from the tree does **not** remove it from git history — flag that explicitly in this task's own commit message and in the final PR description (see Global Constraints).

- [ ] **Step 1: Write the failing test**

Extend `scripts/oss-hygiene.test.ts`:
```ts
import { execFileSync } from "node:child_process";

it("does not track internal AI-build scaffolding referencing the operator's private home directory", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: new URL(".", root), encoding: "utf8" });
  const lfdFiles = tracked.split("\n").filter((line) => line.startsWith(".lfd/"));
  expect(lfdFiles).toEqual([]);
  expect(tracked).not.toContain("prompts/lfd-dev-control-center.md");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run scripts/oss-hygiene.test.ts --reporter=verbose`
Expected: FAIL — `git ls-files` currently lists 64 files under `.lfd/` plus `prompts/lfd-dev-control-center.md`.

- [ ] **Step 3: Remove the files**

```bash
git rm -r .lfd/dcc-build
git rm prompts/lfd-dev-control-center.md
```
(Check first whether `.lfd/` contains anything *outside* `dcc-build/` with `git ls-files .lfd | grep -v '^\.lfd/dcc-build/'` — if it's empty, the whole `.lfd/` directory is gone after this; if not, only `dcc-build/` is removed, matching the investigation's scope.)

- [ ] **Step 4: Add `.lfd/` to `.gitignore` to prevent re-introduction**

Add a line to `.gitignore` (anywhere near the other build/state directories, e.g. after `.deploy-current.next`):
```
.lfd/
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run scripts/oss-hygiene.test.ts --reporter=verbose`
Expected: PASS.

- [ ] **Step 6: Run the full suite to confirm nothing depended on the removed files**

Run: `pnpm verify`
Expected: PASS — `vitest.config.ts` already excluded `.lfd/**` from collection, so no test files are lost from the run; `tsc --noEmit` should be unaffected since nothing under `apps/`/`packages/` imports from `.lfd/` or `prompts/lfd-dev-control-center.md`.

- [ ] **Step 7: Commit, with an explicit history-scrub flag in the message**

```bash
git add -A .lfd .gitignore prompts scripts/oss-hygiene.test.ts
git commit -m "chore: remove internal AI-build scaffolding referencing private paths

Removes .lfd/dcc-build/ and prompts/lfd-dev-control-center.md — internal
agent-build artifacts, not part of the shipped product, that reference the
operator's real home directory path. This removes them from the current
tree only; they remain in git history. Before making this repository
public, a maintainer must decide whether to rewrite history (git
filter-repo / BFG) to fully purge these paths, since the removal here does
not do that."
```

---

### Task 6: Rewrite README.md for external users

**Files:**
- Modify: `README.md` (currently 407 lines — this task restructures and extends it, keeping the accurate installation content that investigation confirmed is already correct)
- Modify: `README.md:131` (the one hardcoded private path inside the env var example block)
- Test: `scripts/oss-hygiene.test.ts` (extends)

Investigation found the README is already largely genericized (only one hardcoded path, `OPENCODE_BIN=/home/deploy/.opencode/bin/opencode` at line 131; no "Internet Nederland"/"Development hub"/"dutchbase" references). This task **adds** the missing new-user-facing sections around the existing, accurate installation content — it does not throw away and rewrite the install steps from scratch.

- [ ] **Step 1: Write the failing test**

Extend `scripts/oss-hygiene.test.ts`:
```ts
it("README leads with what Nexus is, and covers every required open-source section", () => {
  const readme = readFileSync(new URL("README.md", root), "utf8");
  expect(readme.startsWith("# Nexus")).toBe(true);
  expect(readme).not.toContain("/home/deploy/");
  for (const heading of [
    "## What is Nexus?",
    "## Features",
    "## Project status",
    "## Prerequisites",
    "## Installation",
    "## Configuration",
    "### Environment variables",
    "## Running locally",
    "## Production / self-hosted deployment",
    "### Configuring projects",
    "### GitHub integration",
    "### Authentication",
    "## Troubleshooting",
    "## Security",
    "## Contributing",
    "## License",
    "## Contact",
  ]) {
    expect(readme, `README missing section: ${heading}`).toContain(heading);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run scripts/oss-hygiene.test.ts --reporter=verbose`
Expected: FAIL — current README title is `# Development Control Center`, and most of the listed headings don't exist yet (current headings are `## Prerequisites (VPS)`, `## 1. Clone and install`, etc. — numbered/VPS-specific, not the new-user-facing structure this task requires). Note: `### Environment variables`, `### Configuring projects`, `### GitHub integration`, and `### Authentication` are checked as **h3** because Step 3 nests them under the `## Configuration` h2 — match the exact heading level the content below actually uses, don't "fix" this to h2 without also restructuring Step 3's content.

- [ ] **Step 3: Restructure the README**

Rewrite `README.md` end to end. Reuse the existing, investigation-confirmed-accurate content for prerequisites/install/env-vars/migrations/running/systemd/updating/backups/troubleshooting almost verbatim (renumbered under new headings, with "Development Control Center" → "Nexus" and the one hardcoded path fixed); add the missing sections. Full replacement content:

````md
# Nexus

An open-source control center for software projects, AI-assisted development
workflows, pull requests, jobs, and deployments.

## What is Nexus?

Nexus turns a ticket-in, reviewed-PR-out workflow into one controlled
pipeline: public feedback forms feed tickets, an administrator reviews and
approves execution plans, a worker drives AI coding-agent executions against
real project repositories, and results land as pull requests ready for
human review. It also manages the promotion of reviewed changes to
production and keeps an audit trail of the whole path.

Nexus is not tied to one company, one deployment target, or one
infrastructure setup — it's a self-hosted app you run against your own
GitHub repositories and your own Postgres database.

## Features

- **Ticket intake** — public feedback/intake forms that funnel into a
  reviewable ticket queue
- **Planning & execution jobs** — an AI worker drives coding-agent runs
  against your repositories, from an approved plan to a pushed branch
- **Pull request review** — track PR status, policy checks, and merge
  eligibility from one dashboard
- **Production promotion workflows** — controlled, auditable promotion of
  reviewed changes to production, including automated deployment for
  projects that opt in
- **Notifications** — pluggable delivery (webhook/Slack/etc.) for workflow
  events
- **Repository & system health** — visibility into project repository
  status, worker health, and job queue state

## Project status

Nexus is under active development. The core ticket → plan → execute → PR
workflow is in daily production use; some features (e.g. the production
promotion workflow) are opt-in per project and still maturing. Expect
breaking config/schema changes to be called out clearly in release notes —
this is not yet a stable 1.0.

## Prerequisites

- **Node.js 22+** (built and tested on Node 26)
- **pnpm 11** (declared in `packageManager`; `pnpm install` validates
  versions via `engine-strict`)
- **PostgreSQL 15+**, reachable from wherever you run Nexus
- **gcc** and the **libargon2 runtime** (`libargon2-1` on Debian/Ubuntu) —
  `pnpm install` compiles the Argon2 password-hashing helper via
  `postinstall` (`scripts/build-argon2.ts`)
- **git**, and network access to whatever repositories you'll point
  projects at
- **Claude Code CLI** (`claude`) installed and on `$PATH` — the worker
  shells out to it to run executions. Install and authenticate it under the
  same user the worker runs as.
- **Claude Code 2.1.219+**, `bubblewrap`, and `socat` for execution — the
  worker uses Claude Code's native strict Linux sandbox and fails closed
  when that sandbox is unavailable. **Docker is not required.**
- A **GitHub token or GitHub App** with push + pull-request access to the
  repositories you'll manage, if you want the worker to open pull requests
  automatically. See [GitHub integration](#github-integration) below.

Tested on Ubuntu 24.04+; other modern Linux distributions should work but
aren't specifically verified.

### Ubuntu 24.04+ execution sandbox

Install the native sandbox dependencies:

```bash
sudo apt-get install bubblewrap socat
```

Ubuntu 24.04+'s AppArmor policy blocks Bubblewrap from creating the user
namespaces isolation needs. Install the Claude Code-recommended profile and
reload AppArmor:

```bash
sudo tee /etc/apparmor.d/bwrap > /dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
sudo systemctl reload apparmor
```

Do not start execution work until Claude Code confirms its sandbox support
is available — the worker refuses unsandboxed execution rather than falling
back. Claude runs in a temporary private clone with egress restricted to
Claude's own service domains; it cannot reach GitHub or receive worker
credentials directly. The worker verifies results in worker-owned staging
before touching its publishable worktree, re-scans final output for
secrets, then creates a squashed commit, pushes, and opens a draft PR.

## Installation

```bash
git clone https://github.com/dutchbase/dev-control.git
cd dev-control
corepack enable
pnpm install
```

Verify the install:

```bash
pnpm verify
```

This runs TypeScript type-checking plus the full unit test suite — it must
pass before you deploy. Database-backed tests additionally require
`DCC_TEST_DATABASE_URL` to be set (see [Environment variables](#environment-variables)).

## Configuration

### Environment variables

Copy the example file and fill in real values:

```bash
cp .env.example .env
```

Nothing in this repo auto-loads `.env` — wire it up via systemd's
`EnvironmentFile=`, pm2's `env` config, or (for one-off commands)
`set -a; source .env; set +a`. See `.env.example` for every variable this
app reads, with comments. The two most important, always required:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `PORT` | Port `apps/web` listens on |

In production, keep worker-only credentials (`GITHUB_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`, etc.) in a **separate** `.env.worker` file — the
web process is deliberately never given these (see
`apps/web/src/security.ts`'s `workerOnlyCredentials` list, enforced at
process-start via `env -u ...` stripping in `ecosystem.config.cjs`).

### Provisioning PostgreSQL

```bash
sudo -u postgres psql <<'SQL'
CREATE USER nexus WITH PASSWORD 'change-me';
CREATE DATABASE nexus OWNER nexus;
SQL
```

Then run migrations:

```bash
pnpm --filter database migrate
```

Re-run this after every `git pull` that touches
`packages/database/migrations/`.

### Configuring projects

Three YAML files under `config/` drive the app; **all start empty** — Nexus
boots and runs with no projects configured, so there's no private
configuration required just to get it running:

- **`config/projects.yaml`** — the repositories the worker can execute
  against. Add one entry per project before creating tickets against it.
- **`config/notification-providers.yaml`** — webhook/Slack/etc. targets for
  workflow notifications. Optional; delivery failures never block the
  ticket workflow.
- **`config/system.yaml`** — system-level settings.

Minimal working example — add this under `projects:` in
`config/projects.yaml` to register your first project:

```yaml
version: 1
defaults:
  ai:
    model: sonnet
    reasoning_level: high
projects:
  example-app:
    name: Example App
    description: A sample project Nexus can plan and execute against.
    paths:
      repository: /srv/repos/example-app   # required: local clone path, must be a valid git repo
    github:
      owner: your-org
      repository: example-app
    default_branch: main                    # optional, defaults to "main"
```

Required per-project fields: `paths.repository` (entries missing it are
skipped with a warning at import time). Everything else — `github.owner`,
`github.repository`, `default_branch`, and an optional `deployment:` block
for automated production promotion — is optional and validated by
`packages/project-config/src/index.ts` (`validateProject` /
`validateDeploymentConfig`). The `deployment.image.registry` field, if you
use it, must currently be exactly `"ghcr.io"` — that's the only registry
Nexus's deployment flow supports today.

Import/sync the file into the database:

```bash
pnpm projects:import
```

This is idempotent — safe to re-run any time you edit
`config/projects.yaml`.

Edit these files directly wherever you run Nexus — they're config, not
secrets, but don't commit real webhook URLs or tokens into a public fork.

### GitHub integration

Nexus talks to GitHub via a personal access token or GitHub App
installation token (not OAuth) — set `GITHUB_TOKEN` and
`GITHUB_API_BASE_URL` (see `.env.example`). Nexus degrades gracefully with
GitHub features disabled if these are unset; nothing else breaks.

**Minimum permissions needed** for the worker's token, scoped to the
repositories you register in `config/projects.yaml`:

- **Contents: Read and write** — to push branches and commits
- **Pull requests: Read and write** — to open and update PRs
- **Actions: Read** — to check workflow run/job status for merge-eligibility checks
- **Packages: Read** (optional) — only needed if you use the GHCR-based
  deployment/promotion feature; it degrades gracefully without this scope

If you use the included deployment webhook (`webhook-server.js`/
`deploy.sh`), you'll also need a webhook configured on your protected
branch with a shared `WEBHOOK_SECRET` (see `.env.example`).

### Authentication

Nexus's admin UI uses session-cookie auth with a local `users` table
(Argon2-hashed passwords, no external identity provider today). Create the
first admin user after migrating:

```bash
printf %s 'a-strong-password' | pnpm admin:create -- --username admin --password-stdin --non-interactive
```

Passwords are UTF-8 input of 1–4096 bytes; NUL, CR, and LF are rejected.
Use `printf %s`, not `echo` — the password is read from stdin, never
accepted as a command-line argument (which would leak it into shell
history / process listings). Failed logins are rate-limited per account.

## Running locally

```bash
pnpm dev
```

Starts `apps/web` (admin UI + public form + API, on `$PORT`) and
`apps/worker` (the job-queue consumer that drives executions) together,
both logging to your terminal, restarting on file change. Good for a first
smoke test; not what you want for a server you'll walk away from.

**Verify it worked:** open `http://localhost:3000` — it redirects to
`/login`. Sign in with the admin user you created above.

## Production / self-hosted deployment

Run each process under a supervisor so it survives crashes and reboots.
Example with `systemd` (two unit files):

`/etc/systemd/system/nexus-web.service`:

```ini
[Unit]
Description=Nexus — web
After=network.target postgresql.service

[Service]
Type=simple
User=nexus
WorkingDirectory=/opt/nexus
EnvironmentFile=/opt/nexus/.env
Environment=DCC_PROCESS_ROLE=web
Environment=NODE_ENV=production
ExecStart=/usr/bin/env pnpm --filter web dev
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/nexus-worker.service`:

```ini
[Unit]
Description=Nexus — worker
After=network.target postgresql.service

[Service]
Type=simple
User=nexus
WorkingDirectory=/opt/nexus
EnvironmentFile=/opt/nexus/.env
EnvironmentFile=/opt/nexus/.env.worker
Environment=DCC_PROCESS_ROLE=worker
Environment=NODE_ENV=production
ExecStart=/usr/bin/env pnpm --filter worker start
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nexus-web nexus-worker
sudo systemctl status nexus-web nexus-worker
```

(`apps/web` only has a `dev` script — `tsx watch` — which is fine under
systemd too; it just also restarts on source-file changes, harmless in
production since you deploy via `git pull` + restart anyway.)

This repository also includes an optional zero-downtime deploy pipeline
(`deploy.sh` + `webhook-server.js`, driven by `pm2` — see
`ecosystem.config.cjs`) that stages each release as a detached git
worktree, runs `pnpm verify` and migrations, then atomically cuts over. It
is entirely optional infrastructure specific to a PM2-based deployment
style; you can ignore it and manage systemd units directly as shown above.
If you do use it, see
[`docs/DEPLOYMENT-RUNBOOK.md`](docs/DEPLOYMENT-RUNBOOK.md) for the
operator runbook, and set `DCC_ROOT` to wherever you check the repo out
(defaults to `/opt/nexus`).

Put it behind a reverse proxy + TLS (nginx/Caddy) — example Caddyfile:

```
your-domain.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Make sure `APP_BASE_URL` matches the public HTTPS URL — it's used to build
links in outgoing notifications. Set `DCC_TRUST_PROXY_HOPS` to the exact
number of trusted proxies in front of Nexus.

### Backups and recovery drills

```bash
DCC_BACKUP_DIRECTORY=/var/backups/nexus
DCC_BACKUP_RETENTION_DAYS=30
DCC_DATA_DIR=/opt/nexus/data
DCC_CONFIG_DIR=/opt/nexus/config

# Required only for restore drills — must be a separate, disposable database.
DCC_RESTORE_DATABASE_URL=postgresql://nexus:change-me@127.0.0.1:5432/nexus_restore
DCC_RESTORE_ROOT=/var/lib/nexus/recovery-drill
DCC_RESTORE_HEALTH_URL=http://127.0.0.1:3100/api/health
```

Install an external cron entry to run `scripts/backup.sh` on your own
schedule (cron doesn't inherit your service environment, so source it
explicitly in the crontab line). Each backup is atomically published as one
directory containing a database dump, managed data/config, and a manifest;
`.env` files and any `secrets/`, `.key`, `.pem`, `.secret` paths are always
excluded. Run `scripts/restore-drill.sh <backup-dir>` after a successful
backup to verify it's actually restorable — see `README`'s prior revision
or `scripts/restore-drill.sh` itself for the full flag/marker contract.

## Updating

A signed push to your protected branch queues a deployment if you're using
the included webhook flow (GitHub Actions are not a deployment
prerequisite). See
[`docs/DEPLOYMENT-RUNBOOK.md`](docs/DEPLOYMENT-RUNBOOK.md) for full
operator/incident-recovery detail. If you're managing deployment yourself
(no webhook), updating is just: `git pull`, `pnpm install`,
`pnpm --filter database migrate`, restart both processes.

### Superpowers updates

The **Superpowers Update** GitHub Actions workflow runs daily and imports
the latest tagged `obra/superpowers` release into an
`automation/superpowers-<tag>` PR; review and merge that PR to activate it.

## Data layout

Everything under `$DCC_DATA_DIR` (or `$DCC_DATA_ROOT/data` when
`DCC_DATA_DIR` is unset) is managed artifact state: uploaded attachments,
execution logs, and worktrees. Plans are immutable database rows; skill
bundles are temporary and reconstructed per run. Back this directory up
alongside the database — losing it doesn't corrupt the DB, but loses
execution history and in-flight artifacts.

## Troubleshooting

- **Worker can't find `claude`:** confirm `which claude` resolves for the
  exact user/service the worker runs as, not just your login shell.
- **Migrations fail on a fresh DB:** confirm `DATABASE_URL` is set in the
  shell you're running `pnpm --filter database migrate` from — it isn't
  read from `.env` automatically.
- **Admin login locked out:** Nexus rate-limits failed logins per account;
  wait out the lockout window or create a second admin via
  `pnpm admin:create`.
- **`pnpm install` fails to build the Argon2 helper:** confirm `gcc` and
  `libargon2-1` (or your distro's equivalent) are installed — see
  [Prerequisites](#prerequisites).

## Security

- No secrets, tokens, or credentials are committed in this repository — see
  `.gitignore` for what's excluded (`.env`, `.env.*`, `secrets/`, etc.).
- Worker-only credentials (`GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, and
  similar) are deliberately never exposed to the web process — see
  `apps/web/src/security.ts`.
- AI-agent execution runs inside Claude Code's native Linux sandbox
  (bubblewrap-based); the worker fails closed if that sandbox is
  unavailable rather than running unsandboxed.
- If you believe you've found a security vulnerability, please open a
  private report via GitHub's "Report a vulnerability" flow on this
  repository (Security tab) rather than a public issue.

## Contributing

Nexus is actively developed and contributions are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) for how to get set up, what makes a good
PR, and where help is most useful right now.

Want to contribute or discuss an idea?

Open an [issue](https://github.com/dutchbase/dev-control/issues), send a
pull request, or reach out via X/Twitter DM:
[@dutchbase](https://x.com/dutchbase).

## License

[MIT](LICENSE)

## Contact

- **Bugs and feature requests:** [GitHub Issues](https://github.com/dutchbase/dev-control/issues)
- **Code contributions:** GitHub pull requests
- **Anything else:** [@dutchbase on X/Twitter](https://x.com/dutchbase)
````

- [ ] **Step 4: Add a test that Nexus boots with only the tracked, empty default config, and that the README's example config is valid**

Extend `scripts/oss-hygiene.test.ts`:
```ts
import { loadProjectConfig, validateDeploymentConfig } from "@dcc/project-config";
import { parse } from "yaml";

it("the tracked config/projects.yaml (empty, no private data) loads successfully", () => {
  const config = loadProjectConfig(new URL("config/projects.yaml", root).pathname);
  expect(config.version).toBe(1);
  expect(config.projects).toEqual({});
});

it("the README's example project config block is structurally valid YAML with the required fields", () => {
  const readme = readFileSync(new URL("README.md", root), "utf8");
  const match = readme.match(/```yaml\n(version: 1[\s\S]*?example-app:[\s\S]*?)```/);
  expect(match, "README should contain a fenced yaml example with an example-app project").toBeTruthy();
  const parsed = parse(match![1]);
  expect(parsed.projects["example-app"].paths.repository).toBeTruthy();
});
```
(If `loadProjectConfig`'s exported signature differs from `(path: string)` — check `packages/project-config/src/index.ts:16` for the exact signature before writing this — adjust the call accordingly; the investigation's citation for this function is `loadProjectConfig(path = process.env.PROJECTS_CONFIG_PATH ?? resolve("config/projects.yaml"))`, so passing an explicit path should work unchanged.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run scripts/oss-hygiene.test.ts --reporter=verbose`
Expected: PASS — confirms both that Nexus's own default config boots clean with zero private project data, and that the minimal example given to new users in the README actually parses.

- [ ] **Step 6: Manually verify every internal link in the README resolves**

Check each relative link (`[CONTRIBUTING.md](CONTRIBUTING.md)`, `[LICENSE](LICENSE)`, `[docs/DEPLOYMENT-RUNBOOK.md](docs/DEPLOYMENT-RUNBOOK.md)`, `.env.example`) points at a file that actually exists after Tasks 1-5 of this plan have landed — if this task is executed before those, run `ls` to confirm, or execute this plan's tasks in the numbered order to avoid dangling links.

- [ ] **Step 7: Commit**

```bash
git add README.md scripts/oss-hygiene.test.ts
git commit -m "docs: rewrite README for external users under the Nexus name"
```

---

### Task 7: GitHub repository metadata (description + topics only — visibility stays private)

**Files:** none (this task runs `gh` commands, not file edits)

- [ ] **Step 1: Set the repository description and topics**

```bash
gh repo edit dutchbase/dev-control \
  --description "Nexus — an open-source control center for software projects, AI-assisted development workflows, pull requests, jobs, and deployments." \
  --add-topic developer-tools \
  --add-topic devops \
  --add-topic ai-agents \
  --add-topic automation \
  --add-topic github \
  --add-topic deployment \
  --add-topic workflow \
  --add-topic self-hosted \
  --add-topic open-source
```

- [ ] **Step 2: Verify**

```bash
gh repo view dutchbase/dev-control --json description,repositoryTopics,visibility
```
Expected: `description` matches the string above, `repositoryTopics` lists all 9 topics, and `visibility` is **still `"PRIVATE"`** — this task must not change it. If it shows `PUBLIC`, something ran a visibility change that wasn't part of this task; investigate before proceeding (do not silently "fix" it back without understanding why it changed).

- [ ] **Step 3: No commit needed** (this task has no file changes — it's a live GitHub API call, run it once, don't script it into CI).

---

## Final verification

- [ ] Run `pnpm verify` — must pass with zero regressions.
- [ ] Run `pnpm exec vitest run scripts/oss-hygiene.test.ts --reporter=verbose` — every assertion added across Tasks 1-6 passes together.
- [ ] `git ls-files | grep -iE '\.env$|\.env\.local|credential|secret' ` — expect either zero output or only the pre-existing `.lfd`-adjacent test fixture that Task 5 already removed (re-run after Task 5 lands; if `.lfd` was already deleted this should be fully empty).
- [ ] `grep -rn "/home/deploy\|vps-nederland" --include="*.md" --include="*.sh" --include="*.js" .` (excluding `node_modules`, `.git`) — expect zero matches outside of `docs/superpowers/plans/*.md` (historical planning docs from this repo's own development — out of scope for this plan; flag them as a follow-up if the user wants the full history of internal docs scrubbed too, since there are several more hits there per investigation that this plan does not touch).
- [ ] Confirm `gh repo view dutchbase/dev-control --json visibility` still reports `PRIVATE` — this plan never flips it.
- [ ] Manually re-read the final `README.md` top to bottom as a first-time visitor would, and confirm the path "I found this repository on GitHub" → "I understand what Nexus does and have it running locally" holds without needing any information not in the repo itself.
