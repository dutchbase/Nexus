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
