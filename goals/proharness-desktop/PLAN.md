---
title: ProHarness Desktop Delivery Plan
status: active
---

# ProHarness Desktop — Delivery Plan

Phases are ordered. A task is only checked when the behavior exists in the built application, not
when the file merely exists.

## Phase 1 — Shell and contract

- [x] **1.1** Electron + Vite + React/TypeScript shell with a typed preload bridge
- [x] **1.2** Secure IPC surface for settings, goals, git, sessions, permissions, terminal, providers, loop, and shell actions
- [x] **1.3** Warm technical workbench visual system with portable `tokens.css`
- [x] **1.4** Linux packaging configuration for AppImage and `.deb`

## Phase 2 — Plan as a first-class surface

- [x] **2.1** Parse `goals/<id>/DESIGN.md` and `PLAN.md` into goals, phases, and stable task ids
- [x] **2.2** Render goal progress, phases, tasks, and a design dossier in the plan rail
- [x] **2.3** Atomically toggle task checkboxes and notes in `PLAN.md`
- [x] **2.4** Expose plan read/update tools through an in-process Claude Agent SDK MCP server
- [x] **2.5** Watch `goals/` and surface external plan edits without losing selection

## Phase 3 — Claude sessions and permissions

- [x] **3.1** Tabbed multi-session runtime with resume, streaming messages, tool calls, and results
- [x] **3.2** Stop, close, and per-tab permission mode controls
- [x] **3.3** Permission broker with allow-once, remember, deny, risk labels, and fail-closed timeout
- [x] **3.4** Render streaming transcripts with thinking traces and expandable tool I/O
- [x] **3.5** Live smoke test of streaming, permission denial, and invalid-resume recovery in Electron
  - Live streaming, permission deny, and invalid-resume recovery verified in Electron.
- [ ] **3.6** Session transcript persistence across app restarts
- [ ] **3.7** Verify resumable multi-turn context on a host where Claude transcript writes persist

## Phase 4 — Review workbench

- [x] **4.1** Git status, branch, ahead/behind, per-file stats, and unified diff viewer
- [x] **4.2** Untracked-file diffs, copy diff, reveal in folder, and guarded restore
- [x] **4.3** Embedded xterm terminal backed by `node-pty` with pipe fallback
- [x] **4.4** Settings for workspace, model, permission mode, executable, reviewer defaults, and shell
- [ ] **4.5** Automated visual regression snapshots for the main workbench states
- [ ] **4.6** Accessibility audit of keyboard flow, focus order, and modal escape behavior

## Phase 5 — Cross-model delegation

- [x] **5.1** OpenAI-compatible streaming adapter for OpenAI, DeepSeek, and Kimi
- [x] **5.2** Encrypted provider key storage with environment fallbacks
- [x] **5.3** Manual delegation panel with streaming output and send-to-chat
- [x] **5.4** Provider connectivity test action
- [ ] **5.5** Live connectivity test for all three providers with real keys
- [ ] **5.6** Offline contract tests for SSE parsing, provider errors, and cancelled requests

## Phase 6 — Autonomous task loop

- [x] **6.1** Dirty-tree and reviewer-configuration preflight
- [x] **6.2** Next-task selection, implementation session, and diff collection
- [x] **6.3** Independent reviewer gate with bounded revision rounds and fail-closed parsing
- [x] **6.4** Commit implementation, check off task, commit checklist update, and repeat
- [x] **6.5** Pause/resume/stop controls, run limit, live output, review card, and structured log
- [ ] **6.6** End-to-end loop smoke test against a disposable git repository with live models
- [ ] **6.7** Multi-goal queue scheduling

## Phase 7 — Hardening

- [x] **7.1** Package Linux AppImage and `.deb` with the Linux Claude binary and PTY prebuilds
- [ ] **7.2** Add a `--smoke-test` main-process flag that boots the window, checks IPC, and exits
- [x] **7.3** Add unit tests for plan parsing, diff parsing, and review-verdict parsing
- [x] **7.4** Document recovery when `node-pty` or the Agent SDK native binary is unavailable
- [ ] **7.5** Launch the packaged AppImage on a Linux desktop and verify window association
