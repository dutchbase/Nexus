// SEC-15, SEC-16 [BOTH HARD-FAIL] — static grep probes over the BUILT
// source tree, not a running app. This mirrors (and should stay in sync
// with) the same checks harness/lint.sh already runs before score.sh even
// starts the test suites — lint.sh VOIDs the whole run on these violations,
// this file additionally scores them as individual eval cases per
// eval-cases.json's test_ref. Regex choices below are copied from lint.sh
// deliberately, so a change to one should be mirrored in the other.
//
// Repo-root resolution: this file currently lives at
// harness/tests/probes/grep-probes.spec.ts, but "harness/" itself is nested
// under <repo root>/.lfd/<goal-name>/harness/ during LFD authoring (see
// run-evals.sh's own REPO_ROOT computation: `$SCRIPT_DIR/../../..` from
// harness/, which is exactly 3 levels up — harness -> <goal-name> -> .lfd ->
// repo root). From this file (two levels deeper than harness/ itself) that
// is 5 "up" hops, not 4 — verified with a literal path.resolve() against
// this checkout. Rather than hardcode a hop count that breaks if this file
// ever moves, we walk up looking for the ancestor whose immediate child is
// literally named `.lfd` (with a fixed-hop-count fallback for safety).
//
// Both cases must degrade gracefully to a soft pass (not a crash, not a
// hard failure) when apps/web, apps/worker and packages/*/src don't exist
// yet — that's expected on a clean/early checkout, and this probe only
// becomes meaningful once the execution agent has produced real source.

import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { existsSync, readdirSync, statSync } from "fs";
import path from "path";

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, ".lfd"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir, "../../../../.."); // fixed-hop fallback
}

const REPO_ROOT = findRepoRoot(__dirname);

function existingSourceDirs(): string[] {
  const candidates = ["apps/web/src", "apps/worker/src"];
  const dirs: string[] = [];
  for (const c of candidates) {
    const p = path.join(REPO_ROOT, c);
    if (existsSync(p)) dirs.push(p);
  }
  const packagesDir = path.join(REPO_ROOT, "packages");
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir)) {
      const src = path.join(packagesDir, entry, "src");
      if (existsSync(src) && statSync(src).isDirectory()) dirs.push(src);
    }
  }
  return dirs;
}

// Runs `grep -rEn <pattern> <dirs>` excluding node_modules/dist/.next and
// *.spec.ts/*.test.ts, returning matched lines (path:line:content). Never
// scans harness/ — these probes only care about production source.
function grepSrc(pattern: string, dirs: string[]): string[] {
  if (dirs.length === 0) return [];
  const quoted = dirs.map((d) => `"${d}"`).join(" ");
  const cmd = `grep -rEn ${JSON.stringify(pattern)} ${quoted} --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next --exclude='*.spec.ts' --exclude='*.test.ts' 2>/dev/null || true`;
  const out = execSync(cmd, { encoding: "utf8", shell: "/bin/bash" });
  return out.split("\n").filter(Boolean);
}

const strictSandboxEndpointLine = /\/packages\/claude-runner\/src\/index\.ts:\d+:\s*network: \{ allowedDomains: \["api\.anthropic\.com"\], strictAllowlist: true \},\s*$/;


describe("grep probes over built production source", () => {
  it("allows only the exact strict sandbox endpoint line", () => {
    expect(strictSandboxEndpointLine.test("/tmp/repo/packages/claude-runner/src/index.ts:147:      network: { allowedDomains: [\"api.anthropic.com\"], strictAllowlist: true },")).toBe(true);
    expect(strictSandboxEndpointLine.test("/tmp/repo/packages/claude-runner/src/index.ts:147:      network: { allowedDomains: [\"api.anthropic.com\"], strictAllowlist: true }, fetch(\"https://api.anthropic.com\")")).toBe(false);
  });

  it("forbidden literals and imports are absent from production code", () => {
    const dirs = existingSourceDirs();
    if (dirs.length === 0) {
      console.warn(
        "grep-probes: no apps/web/src, apps/worker/src, or packages/*/src exist yet — nothing to scan, trivial pass.",
      );
      expect(true).toBe(true);
      return;
    }

    // The native sandbox permits egress only to Claude's service endpoint.
    // All other occurrences would be a direct Anthropic API call rather than
    // a Claude Code CLI invocation (PRD §18.3/§20.4).
    const anthropicHost = grepSrc("api\\.anthropic\\.com", dirs).filter(
      (line) => !strictSandboxEndpointLine.test(line),
    );
    expect(anthropicHost, `literal api.anthropic.com found:\n${anthropicHost.join("\n")}`).toHaveLength(0);

    // Design-handoff prototype leftovers (design-handoff/*.dc.html,
    // design-handoff/support.js) must never be imported/referenced by real
    // app code.
    const prototypeRefs = grepSrc("\\.dc\\.html|support\\.js", dirs);
    expect(prototypeRefs, `prototype file reference found:\n${prototypeRefs.join("\n")}`).toHaveLength(0);

    // ANTHROPIC_API_KEY may only be referenced inside the auth-guard/refusal
    // module (mock-claude's forbidden-env-var precedence check mirrors this
    // — see harness/mock-claude/claude's FORBIDDEN_VARS). Any other match is
    // a suspicious unguarded read.
    const apiKeyRefs = grepSrc("ANTHROPIC_API_KEY", dirs).filter(
      (line) => !/(auth-guard|claude-guard|subscription-guard|auth\.guard)/i.test(line),
    );
    expect(apiKeyRefs, `ANTHROPIC_API_KEY referenced outside an auth-guard module:\n${apiKeyRefs.join("\n")}`).toHaveLength(0);

    // No hardcoded hex color literal outside the design-tokens CSS file
    // (path containing "token").
    const hexOffenders: string[] = [];
    for (const dir of dirs) {
      const cssLike = execSync(
        `find "${dir}" -type f \\( -name '*.css' -o -name '*.tsx' -o -name '*.ts' \\) 2>/dev/null || true`,
        { encoding: "utf8" },
      )
        .split("\n")
        .filter(Boolean);
      for (const f of cssLike) {
        if (/token/i.test(f) || /node_modules|\/dist\/|\/\.next\//.test(f)) continue;
        if (/\.spec\.ts$|\.test\.ts$/.test(f)) continue;
        const matches = execSync(`grep -noE '#[0-9a-fA-F]{3,8}\\b' "${f}" 2>/dev/null || true`, {
          encoding: "utf8",
        })
          .split("\n")
          .filter(Boolean);
        if (matches.length > 0) hexOffenders.push(`${f}: ${matches.join(", ")}`);
      }
    }
    expect(hexOffenders, `hardcoded hex color outside token file:\n${hexOffenders.join("\n")}`).toHaveLength(0);
  });

  it("no Claude-reachable publication or merge capability under strict execution containment", () => {
    const dirs = existingSourceDirs();
    if (dirs.length === 0) {
      console.warn("grep-probes: no production source exists yet — nothing to scan, trivial pass.");
      expect(true).toBe(true);
      return;
    }

    // Precise, low-false-positive check (mirrors lint.sh hard-fail #4):
    // a constructed merge-endpoint call inside GitHub-provider-shaped code.
    // This is unambiguous — `pulls/{n}/merge` or `.merge(` calls only ever
    // belong to the worker's own PR-sync code, never anything Claude-facing.
    const mergeCallSites = grepSrc("pulls/[^\"']*\\}/merge|\\.merge\\(", dirs).filter((line) =>
      /github|provider/i.test(line),
    );
    expect(mergeCallSites, `possible merge-endpoint call in GitHub provider code:\n${mergeCallSites.join("\n")}`).toHaveLength(0);

    // Heuristic check (documented limitation): git push / git commit / gh /
    // merge granted as an ALLOWED capability to a Claude invocation. The
    // runner's private clone and native strict sandbox are covered by its
    // focused tests; this production-source probe guards the complementary
    // rule that publication remains worker-only.
    // PRD §11.3's example config legitimately lists these same strings in a
    // denied_bash denylist — a naive substring grep would false-positive on
    // that legitimate declaration. So: a match only counts as an "obvious
    // violation" (hard requirement, zero tolerance) when it looks like it's
    // being placed into an ALLOW-shaped list (variable/key names containing
    // "allow"). A match with no allow/deny signal nearby is inconclusive —
    // flagged via console.warn for human review, per SEC-15's own guidance,
    // but does not by itself fail the probe (this is the necessarily-fuzzy
    // half of the check; the merge-call-site check above is the precise
    // half and is a hard zero-tolerance requirement).
    const dangerousCapability = grepSrc("git push|git commit|gh |'\\.merge\\(", dirs);
    const obviousViolations: string[] = [];
    const inconclusive: string[] = [];
    for (const line of dangerousCapability) {
      if (/den(y|ied)|block|forbid|disallowedTools/i.test(line)) continue; // legitimate denylist entry
      if (/allow/i.test(line)) {
        obviousViolations.push(line);
      } else {
        inconclusive.push(line);
      }
    }
    if (inconclusive.length > 0) {
      console.warn(
        `grep-probes: inconclusive git-publish-capability matches (neither clearly allow- nor deny-listed) — flagged for human review, not auto-failed:\n${inconclusive.join("\n")}`,
      );
    }
    expect(
      obviousViolations,
      `git push/commit/gh appears to be granted as an ALLOWED capability:\n${obviousViolations.join("\n")}`,
    ).toHaveLength(0);
  });
});
