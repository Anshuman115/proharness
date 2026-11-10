---
title: ProHarness Desktop
summary: A warm, dense control room for Claude Code that keeps streaming sessions, permissions, git diffs, a real shell, cross-model review, and a markdown plan in one desktop surface.
status: active
---

# ProHarness Desktop

ProHarness is a Linux Electron application for people who run Claude Code for long stretches of
work. It is not a chat wrapper with a file tree bolted on. It is an operations desk: the plan is
visible, every session is a tab, every dangerous action has a face, every changed line can be
reviewed, and an independent model can gate the work before it is committed.

The design goal is **calm density**. A developer should be able to leave the window open all day
without the interface shouting, while still seeing the exact state of a running agent at a glance.

## Product surfaces

1. **Plan rail** — every goal under `goals/`, its phases, progress, and task checklists.
   This is the spine of the app, not a side drawer.
2. **Session tabs** — independent Claude Agent SDK conversations. Each tab has its own SDK
   session id, permission mode, allow-list, transcript, cost readout, and stop control.
3. **Transcript** — streaming text, thinking traces, tool calls with inputs and outputs, and
   errors, rendered as a work log rather than a bubble chat.
4. **Workbench** — four inspectors: Changes, Shell, Delegate, Loop.
   - **Changes** shows the working-tree diff, per-file stats, and a guarded restore action.
   - **Shell** is a real PTY-backed xterm shell rooted in the workspace.
   - **Delegate** streams a prompt to OpenAI, DeepSeek, or Kimi with no tools.
   - **Loop** configures, runs, and observes the autonomous task loop.
5. **Permission dialog** — modal, origin-aware, risk-labelled, with allow-once, always-allow, and
   deny. Loop-originated requests are labelled as such.
6. **Settings** — workspace selection, Claude runtime, encrypted provider keys, reviewer defaults,
   terminal shell, and motion preference.

## Architecture

```text
┌──────────────────────────── Electron main ────────────────────────────┐
│ SettingsService   PlanService   GitService   ProviderService          │
│ PermissionBroker  TerminalService  SessionManager  TaskLoopService    │
│ ClaudeService ── Claude Agent SDK (query + in-process MCP server)      │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ typed contextBridge IPC
┌───────────────────────────────▼───────────────────────────────────────┐
│ React renderer (Zustand)                                               │
│ AppBar · PlanRail · ChatPanel · Workbench · dialogs · status bar       │
└───────────────────────────────────────────────────────────────────────┘
```

The renderer has no Node access. It talks to the main process through `window.proharness`, a
narrow typed API exposed from the preload script. Keys never cross the bridge; the renderer sees
only `hasKey` and a masked hint.

## Session model

Each tab owns a `RuntimeSession` in the main process:

- `tabId` is UI identity; `sdkSessionId` is the Claude Agent SDK resume identity.
- A turn is one `query()` call with `resume: sdkSessionId`, `includePartialMessages: true`, a
  per-turn `AbortController`, and an in-process `proharness` MCP server.
- The normalized event stream (`init`, `message_start`, `delta`, `message`, `tool_result`,
  `notice`, `result`, `error`, `status`) is all the renderer needs.
- The Agent SDK is the only path to Claude. The app does not scrape the CLI or invent its own
  protocol.
- Permission requests pause the SDK callback until the renderer answers, the turn aborts, or the
  request times out. The callback fails closed.

We deliberately use one `query()` per user turn with `resume` instead of a long-lived streaming
input queue: it keeps each tab recoverable, makes stop semantics obvious, and lets the SDK reload
the conversation from its own transcript.

## Goals as the source of truth

```text
goals/
  <goal-id>/
    DESIGN.md     product and architecture intent
    PLAN.md       phases and checklist tasks
```

`PLAN.md` uses one heading per phase and one checkbox per task. Stable ids live in bold:

```md
## Phase 2 — Permission surface
- [ ] **2.1** Build the permission broker
- [x] **2.2** Render the modal
```

The parser is tolerant of extra prose, nested notes, and goals without ids (it derives
`p<phase>-t<index>`). The plan service is the only writer; it updates checkboxes atomically and
never reorders user content.

The in-process MCP server exposes `plan_list`, `plan_read`, `plan_next_task`,
`plan_complete_task`, `plan_add_note`, `git_status`, `delegate_model`, and `review_changes`.
Agents can read and update the plan without receiving raw filesystem access to `goals/`.

## Cross-model review

OpenAI, DeepSeek, and Kimi are treated as OpenAI-compatible chat-completions endpoints. Each has a
stored base URL, model, and encrypted key. A delegate call has no tools and no filesystem; it
streams text back into the UI or into the loop.

The autonomous loop always uses a **non-Claude** provider for the review gate. The reviewer gets
the goal, design excerpt, task, and the full working-tree diff. It must answer:

```text
VERDICT: APPROVE | REQUEST_CHANGES
SUMMARY: …
FINDINGS:
- …
```

A missing or malformed verdict fails closed as `REQUEST_CHANGES`.

## Task loop state machine

```text
preflight → implementing → reviewing ──APPROVE──→ committing → marking → next task
                    ▲            │
                    └── revising ┘  (REQUEST_CHANGES, bounded rounds)
```

Safety properties:

- Refuses to start when the worktree is dirty; loop commits cannot absorb unrelated changes.
- Refuses to start unless the reviewer provider is configured.
- One implementation SDK session per task, resumed for review revisions.
- The reviewer sees the diff, not the implementer's self-report.
- A rejection after the revision limit halts with the diff intact and **nothing committed**.
- On approval, commit the implementation, then check off `PLAN.md`, then commit the plan change.
- Every step is logged and streamed; Stop aborts the current Claude or HTTP request.
- Auto-approval is explicit and warned about; the review/commit gate still applies.

## Terminal

`node-pty` provides a real PTY. If the native module cannot load, the terminal falls back to a
pipe-backed interactive shell and labels itself `pipe`, so the app degrades instead of crashing.
The terminal is mounted for the whole session, not destroyed when the workbench tab changes.

## Visual language

Charcoal paper, copper accent, warm serif display, compact mono utility. No purple gradients, no
glassmorphism cards, no rounded-everything. Hairlines create structure. The accent is reserved for
action, live state, and the plan's next step. See the root `DESIGN.md` and `tokens.css`.

## Non-goals

- Reimplementing Claude Code's agent loop.
- A full IDE editor or language server.
- Sandboxing the shell on behalf of the user.
- Silent commits. The loop's diff gate is the point.
- Windows/macOS packaging in this goal; Linux AppImage and `.deb` are the shipping targets.
