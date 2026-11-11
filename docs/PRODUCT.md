# Product

ProHarness is a macOS desktop app for engineers who use Oh My Pi (`omp`).
It turns a Markdown plan into reviewed, single-task commits.
The app uses the existing omp providers, accounts, skills, and extensions.

## Features

- Session tabs run separate omp processes.
- Approval dialogs show command requests and agent questions.
- Plans contain goals, phases, tasks, and progress.
- The workbench shows Git diffs, a terminal, loop output, and model advice.
- SSH workspaces run omp, Git, plans, and the terminal on the remote host.

## Task loop rules

1. The loop starts with a clean Git tree outside the local goals folder.
2. One implementer session works through the open tasks.
3. A different model reviews each task with read-only tools.
4. A missing verdict counts as a rejection.
5. Rejections return to the implementer up to the revision limit.
6. An approved task produces one code commit.
7. The loop then marks the task complete in the local plan.
8. Unrelated tree changes stop the loop between tasks.

Plans stay in the local goals folder.
The Changes panel, review diffs, and loop commits exclude that folder.

## Scope

The app supports macOS on Apple silicon.
It is not an editor, a hosted service, or a replacement for omp.
Linux builds, Windows builds, telemetry, and shared user accounts are outside the product scope.
