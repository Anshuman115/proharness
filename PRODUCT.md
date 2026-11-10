# ProHarness — Product Context

## What it is

ProHarness is a Linux desktop control room for Claude Code. It wraps the Claude Agent SDK in a
tabbed, streaming workspace and adds the operational surfaces a long-running coding session needs:
a visible project plan, explicit permissions, a real shell, a working-tree diff reviewer, and
independent model review.

## Who it is for

Developers and technical leads who already use Claude Code on real repositories and want to run
several efforts at once without losing the thread. They are comfortable with git, terminals, API
keys, and agent behavior. They value legibility and control more than onboarding gloss.

## The job

**Run a goal to completion while keeping every consequential action inspectable.**

The user should be able to open the app, see the active goal and next task, launch a Claude
session, approve or deny a shell command, inspect the resulting diff, ask a second model for a
review, and start a loop that repeats that cycle — without leaving the window or guessing what
happened.

## Product truths

- Claude Code is the implementer. ProHarness is the harness, not a replacement agent.
- The plan lives in git as markdown. It is portable, diffable, and readable by both humans and
  agents. The UI is a view over it, never a separate database.
- A second model is a review gate, not an devbox. Verdicts must be machine-readable and fail
  closed.
- The shell is powerful. The app must not pretend otherwise. Permission dialogs, risk labels, and
  auto-approval warnings are product features.
- API keys are secrets. They stay in the main process, encrypted at rest where the OS supports it,
  and never cross the renderer bridge.

## Surfaces

1. Plan rail — goals, progress, phases, tasks, design dossier.
2. Session tabs — independent streaming Claude conversations.
3. Transcript — text, reasoning, tool calls, results, errors.
4. Workbench — Changes, Shell, Delegate, Loop.
5. Permission dialog.
6. Settings.

## Success

- A first-run user can find the goal, read the design, start a session, and send a prompt without
  documentation.
- A permission request is understandable in under five seconds: what, why, where, risk.
- A diff review shows the exact changed lines and lets the user restore a tracked file.
- A delegate response visibly streams and can be sent into the active chat.
- The loop refuses unsafe starts, shows its current step, and halts without committing when review
  fails.
- The app still opens when a provider key is missing and tells the user what is missing.

## Non-goals

- Editor, language server, or full IDE.
- Remote/multi-user collaboration.
- A hosted service or telemetry.
- Hiding the cost or risk of autonomous execution.
- Windows/macOS packaging in this build. Linux AppImage and `.deb` are the deliverables.

## Assumptions made from the brief

- Desktop Linux is the primary runtime; the app is developed on macOS and packaged for Linux.
- Claude Code login or `ANTHROPIC_API_KEY` is acceptable authentication for the implementer.
- Providers are OpenAI-compatible chat-completions endpoints.
- The workspace is a git repository; the loop requires a clean tree.
- The app may be run from source with `pnpm dev` or as a packaged Electron app.
