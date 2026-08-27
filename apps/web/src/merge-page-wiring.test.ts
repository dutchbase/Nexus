import { beforeEach, describe, expect, test, vi } from "vitest";

// Renders the real admin shell for /admin/merge and executes its inline
// script against a minimal DOM stub — catches broken wiring that static
// reading of the template misses.

process.env.DATABASE_URL ??= "postgresql://test/tee";

const pool = { query: vi.fn() };
vi.mock("@dcc/database", () => ({ pool }));

const { adminPage } = await import("./ui.ts");
const mergePage = await import("./pages/merge.ts");

const defaultProjectRow = { id: "p1", name: "Widgets", default_branch: "master" };

// Default: the project-picker query resolves to one connected project; the
// va-jobs-platform lookup resolves to nothing (pre-migration-059 state) —
// individual tests override this via pool.query.mockImplementation.
beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockImplementation(async (sql: string) =>
    sql.includes("va-jobs-platform") ? { rows: [] } : { rows: [defaultProjectRow] });
});

type Stub = ReturnType<typeof makeElement>;

function makeElement(id: string | null) {
  const listeners: Record<string, Array<() => unknown>> = {};
  return {
    id,
    value: "",
    innerHTML: "",
    textContent: "",
    disabled: false,
    hidden: false,
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    selectedOptions: [] as Array<{ dataset: Record<string, string> }>,
    options: [] as unknown[],
    addEventListener(event: string, handler: () => unknown) {
      (listeners[event] ??= []).push(handler);
    },
    dispatch(event: string) {
      return Promise.all((listeners[event] ?? []).map((handler) => handler()));
    },
  };
}

function makeContainer(id: string | null, children: Record<string, Stub> = {}) {
  const el = makeElement(id) as Stub & { querySelector: (selector: string) => Stub | null; showModal: () => void; close: () => void };
  el.showModal = () => undefined;
  el.close = () => undefined;
  el.querySelector = (selector: string) => children[selector] ?? null;
  return el;
}

function stubDocument(options: { production?: boolean } = {}) {
  const projectSelect = makeElement("merge-project");
  const fromSelect = makeElement("merge-from");
  const intoSelect = makeElement("merge-into");
  const statusBox = makeElement(null);
  const button = makeElement(null);
  const reason = makeElement(null);
  const retry = makeElement(null);
  retry.hidden = true;

  const production = options.production ? (() => {
    const status = makeElement(null);
    status.dataset.projectId = "va-1";
    const preflight = makeElement(null);
    const progress = makeElement(null);
    const promoteButton = makeElement(null);
    const promoteRetry = makeElement(null);
    promoteRetry.hidden = true;
    const promoteReason = makeElement(null);
    const dialog = makeContainer(null, {
      "[data-production-promote-dialog-sha]": makeElement(null),
      "[data-production-promote-dialog-message]": makeElement(null),
      "[data-production-promote-dialog-cancel]": makeElement(null),
      "[data-production-promote-dialog-confirm]": makeElement(null),
    });
    const divergedWarning = makeContainer(null, {
      "[data-diverged-production-sha]": makeElement(null),
      "[data-diverged-master-sha]": makeElement(null),
    });
    divergedWarning.hidden = true;
    const forceButton = makeElement(null);
    const forceDialog = makeContainer(null, {
      "[data-production-force-dialog-sha]": makeElement(null),
      "[data-production-force-dialog-input]": makeElement(null),
      "[data-production-force-dialog-cancel]": makeElement(null),
      "[data-production-force-dialog-confirm]": makeElement(null),
    });
    const refreshButton = makeElement(null);
    return { status, preflight, progress, promoteButton, promoteRetry, promoteReason, dialog, divergedWarning, forceButton, forceDialog, refreshButton };
  })() : null;

  const documentStub = {
    cookie: "",
    getElementById: (id: string) =>
      id === "merge-project" ? projectSelect : id === "merge-from" ? fromSelect : id === "merge-into" ? intoSelect : null,
    querySelector: (selector: string) =>
      selector === "[data-merge-status]" ? statusBox
        : selector === "[data-merge-button]" ? button
        : selector === "[data-merge-reason]" ? reason
        : selector === "[data-merge-retry]" ? retry
        : selector === "[data-production-promotion-status]" ? production?.status ?? null
        : selector === "[data-production-promotion-preflight]" ? production?.preflight ?? null
        : selector === "[data-production-promotion-progress]" ? production?.progress ?? null
        : selector === "[data-production-promote-button]" ? production?.promoteButton ?? null
        : selector === "[data-production-promote-retry]" ? production?.promoteRetry ?? null
        : selector === "[data-production-promote-reason]" ? production?.promoteReason ?? null
        : selector === "[data-production-promote-dialog]" ? production?.dialog ?? null
        : selector === "[data-production-diverged-warning]" ? production?.divergedWarning ?? null
        : selector === "[data-production-force-button]" ? production?.forceButton ?? null
        : selector === "[data-production-force-dialog]" ? production?.forceDialog ?? null
        : null,
    querySelectorAll: (selector: string) =>
      selector === "[data-refresh-production-promotion]" && production ? [production.refreshButton] : [],
    documentElement: { dataset: {} as Record<string, string> },
    addEventListener: () => undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
  };
  return { documentStub, projectSelect, fromSelect, intoSelect, statusBox, button, reason, retry, production };
}

describe("merge workbench page wiring", () => {
  test("inline script attaches handlers and populates branches on project change", async () => {
    const page = await mergePage.render(new URL("http://x/admin/merge"), { username: "a", user_id: "u" }, {});
    expect(page).toBeTruthy();
    const shell = adminPage("/admin/merge", page!.title, page!.body, {}, "a");

    const scripts = [...shell.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    expect(scripts.length).toBeGreaterThan(0);
    const wired = scripts.find((source) => source.includes("merge-project"));
    expect(wired).toBeDefined();

    const stubs = stubDocument();
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string): Promise<any> => {
      calls.push(url);
      if (url.includes("/merge-preview")) {
        return { ok: true, status: 202, json: async () => ({ job: { id: "job-1" } }) };
      }
      if (url.includes("/api/admin/jobs/")) {
        return {
          ok: true,
          json: async () => ({
            job: {
              status: "completed",
              result_json: {
                outcome: "branches_only",
                branches: [{ name: "master" }, { name: "staging" }],
                head: null,
                base: null,
                commits_ahead: null,
                conflicted_files: [],
              },
            },
          }),
        };
      }
      throw new Error("unexpected fetch " + url);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Execute exactly what the browser would execute.
    new Function("document", "fetch", "sessionStorage", "localStorage", "location", "confirm", "alert", "matchMedia", "window", wired!)(
      stubs.documentStub,
      fetchMock,
      { getItem: () => "csrf" },
      { getItem: () => null, setItem: () => undefined },
      { href: "" },
      () => true,
      () => undefined,
      () => ({ matches: false, addEventListener: () => undefined }),
      { location: { pathname: "/admin/merge" } },
    );

    stubs.projectSelect.value = "p1";
    await stubs.projectSelect.dispatch("change");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    if (stubs.fromSelect.innerHTML.includes("Loading")) console.error("DEBUG status:", stubs.statusBox.textContent, "reason:", stubs.reason.textContent);

    expect(calls.some((url) => url.includes("/merge-preview"))).toBe(true);
    expect(stubs.fromSelect.innerHTML).toContain("staging");
    expect(stubs.intoSelect.innerHTML).toContain("master");
    // Default "from" is the project default branch.
    expect(stubs.fromSelect.value).toBe("master");
    expect(stubs.button.disabled).toBe(true);
    expect(stubs.reason.textContent).toContain("merge into");
  });

  test("a clean verdict enables the button and a conflict keeps it off with reasons", async () => {
    const page = await mergePage.render(new URL("http://x/admin/merge"), { username: "a", user_id: "u" }, {});
    const shell = adminPage("/admin/merge", page!.title, page!.body, {}, "a");
    const wired = [...shell.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("merge-project"))!;

    for (const verdict of [
      {
        outcome: "clean",
        expectDisabled: false,
        reasonFragment: "Ready",
        result: { outcome: "clean", commits_ahead: 3, head: { name: "staging", sha: "a".repeat(40) }, base: { name: "master", sha: "b".repeat(40) } },
      },
      {
        outcome: "conflict",
        expectDisabled: true,
        reasonFragment: "",
        result: { outcome: "conflict", conflicted_files: ["shared.txt"], head: null, base: null },
      },
    ]) {
      const stubs = stubDocument();
      stubs.projectSelect.value = "p1";
      stubs.fromSelect.value = "staging";
      stubs.intoSelect.value = "master";
      let requested: any = {};
      globalThis.fetch = vi.fn(async (url: string, init?: any): Promise<any> => {
        if (url.includes("/merge-preview")) {
          requested = JSON.parse(init?.body ?? "{}");
          return { ok: true, status: 202, json: async () => ({ job: { id: "j" } }) };
        }
        if (url.includes("/api/admin/jobs/")) {
          const paired = Boolean(requested.head && requested.base);
          return {
            ok: true,
            json: async () => ({
              job: {
                status: "completed",
                result_json: paired
                  ? verdict.result
                  : { outcome: "branches_only", branches: [{ name: "staging" }, { name: "master" }] },
              },
            }),
          };
        }
        throw new Error("unexpected");
      }) as unknown as typeof fetch;

      new Function("document", "fetch", "sessionStorage", "localStorage", "location", "confirm", "alert", "matchMedia", "window", wired)(
        stubs.documentStub,
        globalThis.fetch,
        { getItem: () => "csrf" },
        { getItem: () => null, setItem: () => undefined },
        { href: "" },
        () => true,
        () => undefined,
        () => ({ matches: false, addEventListener: () => undefined }),
        { location: { pathname: "/admin/merge" } },
      );
      stubs.intoSelect.dispatch("change");
      await new Promise((resolve) => setTimeout(resolve, 1200));

      expect(stubs.button.disabled).toBe(verdict.expectDisabled);
      if (verdict.expectDisabled) expect(stubs.statusBox.textContent.toLowerCase()).toContain("conflict");
      else expect(stubs.reason.textContent).toContain("3 commit");
    }
  });

  test("a timed-out branch load surfaces Retry, clears Loading, and Retry re-runs the check", async () => {
    const page = await mergePage.render(new URL("http://x/admin/merge"), { username: "a", user_id: "u" }, {});
    const shell = adminPage("/admin/merge", page!.title, page!.body, {}, "a");
    const wired = [...shell.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("merge-project"))!;

    const stubs = stubDocument();
    stubs.projectSelect.value = "p1";
    let previewCalls = 0;
    globalThis.fetch = vi.fn(async (url: string): Promise<any> => {
      if (url.includes("/merge-preview")) {
        previewCalls += 1;
        return { ok: true, status: 202, json: async () => ({ job: { id: "j" } }) };
      }
      if (url.includes("/api/admin/jobs/")) {
        // Job never completes within the poll window.
        return { ok: true, json: async () => ({ job: { status: "running" } }) };
      }
      throw new Error("unexpected " + url);
    }) as unknown as typeof fetch;

    vi.useFakeTimers();
    try {
      new Function("document", "fetch", "sessionStorage", "localStorage", "location", "confirm", "alert", "matchMedia", "window", wired)(
        stubs.documentStub,
        globalThis.fetch,
        { getItem: () => "csrf" },
        { getItem: () => null, setItem: () => undefined },
        { href: "" },
        () => true,
        () => undefined,
        () => ({ matches: false, addEventListener: () => undefined }),
        { location: { pathname: "/admin/merge" } },
      );

      stubs.projectSelect.dispatch("change");
      await vi.advanceTimersByTimeAsync(21_500);

      // Timeout message shown, Retry visible, dropdowns left the Loading state.
      expect(stubs.statusBox.textContent).toContain("timed out");
      expect(stubs.retry.hidden).toBe(false);
      expect(stubs.fromSelect.innerHTML).not.toContain("Loading");
      expect(stubs.fromSelect.innerHTML).toContain("Could not load branches");
      expect(stubs.intoSelect.innerHTML).toContain("Could not load branches");
      expect(stubs.button.disabled).toBe(true);

      // Retry re-runs the whole check (fresh preview job) and hides itself meanwhile.
      stubs.retry.dispatch("click");
      expect(stubs.retry.hidden).toBe(true);
      await vi.advanceTimersByTimeAsync(21_500);
      expect(previewCalls).toBe(2);
      expect(stubs.retry.hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("existing merge-branches DOM elements and event listeners are still wired after the Production tab is added", async () => {
    const page = await mergePage.render(new URL("http://x/admin/merge"), { username: "a", user_id: "u" }, {});
    const shell = adminPage("/admin/merge", page!.title, page!.body, {}, "a");
    const wired = [...shell.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("merge-project"))!;

    // Case A: the production-tab markup is absent from the DOM (defensive
    // guard — mirrors initDeploymentTab's own `if(!el)return` pattern).
    // The merge-branches elements must still be found and wired, and
    // initProductionPromotion() must not throw when its elements are missing.
    const noProduction = stubDocument({ production: false });
    globalThis.fetch = vi.fn(async () => { throw new Error("unexpected fetch"); }) as unknown as typeof fetch;
    expect(() => new Function("document", "fetch", "sessionStorage", "localStorage", "location", "confirm", "alert", "matchMedia", "window", wired!)(
      noProduction.documentStub, globalThis.fetch,
      { getItem: () => "csrf" }, { getItem: () => null, setItem: () => undefined },
      { href: "" }, () => true, () => undefined,
      () => ({ matches: false, addEventListener: () => undefined }),
      { location: { pathname: "/admin/merge" } },
    )).not.toThrow();
    expect(noProduction.documentStub.getElementById("merge-project")).toBe(noProduction.projectSelect);
    expect(noProduction.documentStub.querySelector("[data-merge-button]")).toBe(noProduction.button);

    // Case B: the production-tab markup IS present (this page's real markup)
    // — initProductionPromotion() must run without throwing and must reach
    // out to the deployment status/pre-flight endpoints.
    const withProduction = stubDocument({ production: true });
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/deployment/promote-check")) return { ok: true, json: async () => ({ job: { id: "job-check" } }) };
      if (url.includes("/api/admin/jobs/")) return { ok: true, json: async () => ({ job: { status: "completed", result_json: { eligible: false, reasons: ["master_workflow_not_found"] } } }) };
      if (url.endsWith("/deployment")) return { ok: true, json: async () => ({ snapshot: null, releases: [] }) };
      throw new Error("unexpected fetch " + url);
    }) as unknown as typeof fetch;
    expect(() => new Function("document", "fetch", "sessionStorage", "localStorage", "location", "confirm", "alert", "matchMedia", "window", wired!)(
      withProduction.documentStub, globalThis.fetch,
      { getItem: () => "csrf" }, { getItem: () => null, setItem: () => undefined },
      { href: "" }, () => true, () => undefined,
      () => ({ matches: false, addEventListener: () => undefined }),
      { location: { pathname: "/admin/merge" } },
    )).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(calls.some((url) => url.endsWith("/deployment"))).toBe(true);
    expect(calls.some((url) => url.includes("/deployment/promote-check"))).toBe(true);
  });

  test("merge.ts renders both a Merge branches tab and a Production tab with VA Jobs Platform nested inside", async () => {
    pool.query.mockImplementation(async (sql: string) =>
      sql.includes("va-jobs-platform") ? { rows: [{ id: "va-1", config_json: { deployment: { enabled: true } } }] } : { rows: [defaultProjectRow] });

    const page = await mergePage.render(new URL("http://x/admin/merge"), { username: "a", user_id: "u" }, {});
    expect(page).toBeTruthy();
    expect(page!.body).toContain("Merge branches");
    expect(page!.body).toContain("Production");
    expect(page!.body).toContain("VA Jobs Platform");
    expect(page!.body).toContain('data-project-id="va-1"');
  });

  test("merge.ts still renders correctly when va-jobs-platform is not yet configured (pre-migration-059 state)", async () => {
    pool.query.mockImplementation(async (sql: string) => (sql.includes("va-jobs-platform") ? { rows: [] } : { rows: [defaultProjectRow] }));

    const page = await mergePage.render(new URL("http://x/admin/merge"), { username: "a", user_id: "u" }, {});
    expect(page).toBeTruthy();
    expect(page!.body).toContain("Merge branches");
    expect(page!.body).toContain("VA Jobs Platform is not configured yet");
  });
});
