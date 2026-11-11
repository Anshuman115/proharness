# ProHarness

A Linux desktop control room for Claude Code. Tabbed streaming sessions, visible permissions, a real
shell, git diff review, cross-model delegation, markdown goals, and an autonomous task loop that
implements → reviews → commits → checks off → repeats.

Built with **Electron + React + TypeScript** on top of the **Claude Agent SDK**. Planning lives in
`goals/<goal>/DESIGN.md` and `PLAN.md`; agents read and update it through an in-process MCP tool, not
through raw filesystem access.

![ProHarness workbench](docs/proharness.png)

## What is in the app

- **Tabbed sessions** — each tab is an independent Claude Agent SDK conversation with `resume`,
  streaming partial messages, tool-call input/output, thinking traces, cost, stop, and its own
  permission mode.
- **Permission dialogs** — allow once, always allow (SDK rule), deny. Risk-labelled, origin-aware,
  fail-closed. Loop-originated requests are labelled.
- **Embedded terminal** — xterm.js with a PTY (`@homebridge/node-pty-prebuilt-multiarch`, which ships
  N-API prebuilds for Linux x64/arm64) rooted at the workspace. If the native module cannot load, it
  degrades to a pipe shell and says so in the UI.
- **Diff review** — branch/ahead/behind, per-file stats, unified diff with line numbers, untracked
  files, copy, reveal, and a two-step restore for tracked files.
- **Cross-model delegation** — OpenAI, DeepSeek, and Kimi over OpenAI-compatible streaming
  endpoints. Manual panel plus agent-callable MCP tools.
- **Goal planning** — `goals/<id>/DESIGN.md` + `PLAN.md`, parsed into phases and checklists. Edit
  in git or let an agent check tasks off.
- **Autonomous loop** — preflight clean tree, pick next task, implement with Claude, review the
  diff with a different model, revise on rejection, commit, check off, commit the plan, repeat.

## Requirements

- Node.js 22+ (developed with Node 26)
- pnpm 11+ (or npm with equivalent commands)
- Linux for packaging; macOS works for development
- A git repository as the workspace
- Claude Code login (`~/.claude`) **or** `ANTHROPIC_API_KEY`
- At least one API key for OpenAI / DeepSeek / Kimi to use delegation or the autonomous loop

## Quick start

```bash
pnpm install
pnpm dev
```

`pnpm install` also ensures the Electron binary is present (`scripts/postinstall.cjs`). If Electron
was installed with build scripts disabled, run:

```bash
node node_modules/electron/install.js
```

Set a workspace on first launch. In development the app defaults to this repository. Pick any git
repository with a `goals/` folder.

### API keys

Keys can be set in **Settings → Delegation models**, or supplied through the environment:

| Provider | Environment variable | Default endpoint | Default model |
| --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `https://api.openai.com/v1` | `gpt-5.1` |
| DeepSeek | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Kimi | `MOONSHOT_API_KEY` or `KIMI_API_KEY` | `https://api.moonshot.ai/v1` | `kimi-k2-0905-preview` |

Claude authentication uses the Claude Code login unless `ANTHROPIC_API_KEY` is set. Keys entered in
the UI are encrypted with Electron `safeStorage` (OS keychain where available) and never returned to
the renderer. The renderer only receives `hasKey` and a masked hint.

> The app does not sandbox the shell. Treat permission dialogs and the loop's auto-approval warning
> as safety controls, not decoration.

## Goal format

```text
goals/
  proharness-desktop/
    DESIGN.md
    PLAN.md
```

`DESIGN.md` explains intent and architecture. `PLAN.md` is a checklist grouped by phases:

```md
## Phase 1 — Foundation

- [x] **1.1** Electron shell and typed bridge
- [ ] **1.2** Next task
```

- Every `##` heading starts a phase.
- Every `- [ ]` / `- [x]` line is a task.
- A bold id (`**1.2**`) is stable. Without one the parser derives `p<phase>-t<index>`.
- Indented `-` notes below a task are read as completion notes.
- The UI can check/uncheck a task; the write is atomic and preserves the rest of the file.

The plan rail is the source of truth for the loop. The loop always takes the first unchecked task in
file order.

## MCP tools exposed to Claude

The app registers an in-process `proharness` MCP server with every session:

| Tool | Purpose |
| --- | --- |
| `plan_list` | List goals, progress, open counts |
| `plan_read` | Read one goal's design + plan, or all goals |
| `plan_next_task` | First unchecked task with design/plan paths |
| `plan_complete_task` | Check off a task (after verification) |
| `plan_add_note` | Append a progress note under a task |
| `git_status` | Branch + changed files |
| `delegate_model` | Ask OpenAI / DeepSeek / Kimi |
| `review_changes` | Another model reviews the working-tree diff |

The plan and `git_status` tools run without a prompt because they only touch the local plan and read
git state. `delegate_model` and `review_changes` send repository content to a third-party API, so they
go through the normal permission dialog. Inside the autonomous loop, `plan_complete_task` is disabled
for the implementer: the loop owns the commit and the checkoff.

## Autonomous task loop

Open **Workbench → Loop**, choose a goal and a reviewer provider, then start.

```text
preflight ─→ implementing ─→ reviewing ──APPROVE──→ committing ─→ checking off ─→ next task
                   ▲              │
                   └── revising ──┘   REQUEST_CHANGES (bounded rounds)
```

Safety behavior:

1. **Preflight** refuses a dirty git worktree, a missing reviewer key, or a goal with no open tasks.
2. **Implement** runs Claude with the task prompt, resuming one SDK session per task.
3. **Review** sends the actual git diff (not the agent's summary) to the reviewer model.
4. **Revise** feeds findings back to the same Claude session, up to the configured round limit.
5. **Commit** only after a parsed `VERDICT: APPROVE`. The implementation commit is separate from the
   plan commit.
6. **Check off** updates `PLAN.md`, then commits that change.
7. **Repeat** until the run limit, no tasks, pause, stop, or an error.

If review rejects after the revision limit, the loop halts, leaves the diff intact, and commits
nothing. If the implementer produces no changes, the loop fails. Reviewer output without a
machine-readable verdict is treated as `REQUEST_CHANGES`.

Auto-approve is explicit. With it on, the implementer can run shell commands without a dialog; the
independent review and commit gate still apply, and Stop aborts the in-flight action.

## Architecture

```text
src/
  shared/                 types + IPC channels + preload API contract
  main/
    index.ts              window, services, event wiring
    ipc.ts                validated ipcMain handlers
    services/
      settings.ts         settings, encrypted secrets, env fallbacks
      plan.ts             goals parser/watcher/atomic writes
      git.ts              status, diff, restore, commit
      claude.ts           Agent SDK query loop + event normalization
      sessions.ts         tab runtime, resume, stop, allow-lists
      permissions.ts      promise-based permission broker
      mcp.ts              in-process proharness MCP server
      providers.ts        OpenAI-compatible streaming + test
      review.ts           review prompt + fail-closed verdict parser
      terminal.ts         PTY with pipe fallback
      task-loop.ts        autonomous state machine
  preload/index.ts        contextBridge API
  renderer/src/           React UI (Zustand)
```

The renderer has no Node integration. `contextIsolation` is on, `nodeIntegration` is off. The main
process owns all filesystem, git, secret, process, and network access.

## Keyboard shortcuts

On Linux the shortcuts use **Ctrl+Shift** so plain Ctrl keys (Ctrl+W, Ctrl+T, Ctrl+B in the shell)
keep working in the terminal and text fields. On macOS they use **⌘**.

| Shortcut | Action |
| --- | --- |
| Ctrl+Shift+T | New session tab |
| Ctrl+Shift+W | Close session tab |
| Ctrl+Shift+, | Settings |
| Ctrl+Shift+J | Toggle plan rail |
| Ctrl+Shift+B | Toggle workbench |

## Scripts

```bash
pnpm dev          # Electron + Vite dev server
pnpm typecheck    # main + renderer TypeScript
pnpm build        # typecheck + production build to out/
pnpm dist:linux   # build AppImage + .deb into release/
pnpm dist:dir     # unpacked Linux directory
pnpm test         # unit tests (plan, diff, review, git, providers, task loop)
```

## Packaging Linux

```bash
pnpm dist:linux
```

Outputs `release/ProHarness-*.AppImage` and `release/proharness_*.deb` for Linux x64. The config
lives in `electron-builder.yml`. Set the target architecture explicitly with `--arm64` (and stage an
arm64 Claude binary) if you need ARM64 Linux.

The build is cross-platform-aware. `scripts/fetch-linux-sdk.mjs` downloads the matching Linux
Claude Code binary into `.cache/linux-sdk/` (about 326 MB), and `scripts/after-pack.cjs` copies it
to `resources/claude` in the packaged app. On Linux, pnpm's optional dependency resolution normally
provides the binary itself. The download is verified against the SHA-256 checksum in the Agent SDK's
`manifest.json`. The PTY package and its prebuilds are unpacked from the asar so the native module can
load; the app also keeps a pipe-shell fallback.

The AppImage and `.deb` are built and structurally verified on macOS. Launching the AppImage on a
real Linux desktop is the remaining hardening task in `goals/proharness-desktop/PLAN.md`.

## Troubleshooting

**The window opens but no goals appear.**
`goals/` must exist under the selected workspace and each goal folder needs `DESIGN.md`. Use
**Open goals folder** in the plan rail.

**The loop won't start.**
It requires a clean worktree and a configured reviewer. Commit your current work first. A dirty tree
is rejected so the loop cannot accidentally commit unrelated files.

**Claude fails to start.**
Run `claude --version` in a terminal. If you use API-key auth, set `ANTHROPIC_API_KEY` or enter a key
in Settings. The Agent SDK also honors a custom executable path in Settings.

**The terminal says `pipe`.**
The PTY module could not load or could not open a pseudo-terminal (for example inside a restrictive
sandbox). Reinstall dependencies so `@homebridge/node-pty-prebuilt-multiarch` places its prebuild. The
app remains usable, but full-screen programs will not work.

**Delegation returns 401/404.**
Check the provider base URL (including `/v1` where required), model id, and key. Use the **Test**
button in Settings; it does a real small completion.

**The loop halted with changes intact.**
That is intentional. Review the diff in **Changes**, then either fix it manually, ask a chat session
to address the reviewer findings, or discard the changes. Nothing was committed.

## Known limitations

- Session transcripts are in memory for the app process; tabs do not survive a restart yet.
- The loop works one task at a time in one goal; no multi-goal queue yet.
- The loop commits locally only. It never pushes.
- Provider streaming assumes OpenAI-compatible SSE. Native Anthropic / Gemini delegate protocols are
  out of scope.
- Auto-update is not wired up.
- The AppImage has not been launched on a real Linux desktop in this environment; the `.deb` and
  AppImage payloads are built and inspected. See `goals/proharness-desktop/PLAN.md` task 7.5.

## License

MIT.
