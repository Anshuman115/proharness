# ProHarness

ProHarness is a macOS desktop app for Oh My Pi (`omp`).
It adds session tabs, approval dialogs, plans, Git diffs, a terminal, and a task loop with model review.
The app uses omp for agent work.

## Rules

- Keep changes small and complete.
- Use the existing TypeScript patterns, two-space indentation, single quotes, and no semicolons.
- Use ASD-STE100 Simplified Technical English for new or changed prose, including comments.
- Use generic examples in docs and tests.
- Keep personal data, credentials, local paths, and session data out of tracked files.
- Keep Git and process operations in the main process behind the typed IPC API.
- Preserve approval checks, workspace isolation, and the review step before loop commits.
- Add tests for changed behavior.
- Run `pnpm test` and `pnpm build` after code changes.
- Run live model or SSH tests only with explicit permission.

## Docs

Read the [docs index](<docs/README.md>) before product or architecture changes.
Use its links for product rules, architecture, UI design, and development checks.
Update the relevant doc when behavior changes.
