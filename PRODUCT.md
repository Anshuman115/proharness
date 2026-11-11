# ProHarness: product context

## What it is

ProHarness is a macOS desktop workbench for Oh My Pi (omp). omp does all the agent work. ProHarness adds the things a long, multi-step effort needs: parallel tabs, a plan that outlives any one session, approvals you can see, a diff reviewer, and a loop in which one model builds and a different model reviews every task before it is committed.

## Who it is for

Engineers who already use omp with several providers (here: Claude, OpenAI Codex, and Command Code's DeepSeek V4.1 Flash) and want to run goals to completion without babysitting a terminal.

## The job

**Turn a written plan into a series of reviewed, single-task commits, and keep every consequential action inspectable.**

## Product truths

- omp is the agent. ProHarness never calls a model API directly; every turn is an `omp --mode rpc` process using the user's own omp config, logins, skills and extensions.
- The plan is markdown in `goals/` that the agent can read. It is local working state: kept out of git through `.git/info/exclude`, never committed by the loop, never shown as a change.
- Review is a gate, not advice. The reviewer must be a different model, sees the real diff, has read-only tools, and any reply without a verdict counts as a rejection.
- One task, one commit. The loop refuses a dirty tree and stops if the tree changes between tasks.
- Approval prompts are a feature. Chat defaults to letting edits run and asking before commands, and the loop shows its approval mode up front.

## Surfaces

1. Plan rail: goals, progress, phases, tasks, new-goal drafting.
2. Session tabs: one omp process each, with model, effort, context meter, cost, queue, todos.
3. Workbench: Changes, Loop, Consult, Shell.
4. Request dialog: approvals, `ask` questions, extension prompts.
5. Command palette and Settings.

## Non-goals

- Replacing omp's agent, tools or TUI features.
- Editor, language server, or IDE.
- Hosted service, telemetry, multi-user.
- Linux or Windows builds.
