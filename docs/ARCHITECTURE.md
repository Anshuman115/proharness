# Architecture

The Electron main process owns system operations.
The preload API connects the React UI to the main process through typed IPC.

## Main parts

| Part | Responsibility |
| --- | --- |
| [Main entry](<../src/main/index.ts>) | Create services, connect events, and close resources. |
| [Hosts](<../src/main/host/>) | Run local or SSH file and process operations through `WorkspaceHost`. |
| [omp adapter](<../src/main/omp/>) | Manage RPC transport, agent events, and process discovery. |
| [Services](<../src/main/services/>) | Own sessions, plans, Git, settings, approvals, and the task loop. |
| [Preload API](<../src/preload/api.ts>) | Expose the supported UI operations. |
| [Shared IPC contract](<../src/shared/ipc.ts>) | Define request and event types. |
| [Renderer store](<../src/renderer/src/store.ts>) | Own UI state and reject stale workspace results. |

## Ownership rules

The workspace service coordinates workspace changes and agent shutdown.
The workspace gate blocks new work during these changes.
The agent factory creates chat, implementer, and reviewer processes.

Keep host-specific operations behind `WorkspaceHost`.
Keep IPC types in the shared contract.
Close processes and watchers when their owner stops.

## Polling

Plan and Git watchers poll the selected workspace.
A direct `EACCES` or `EPERM` error stops a watcher and drops its queued work.
A workspace change resets the watcher and tries again.
Other errors keep retrying.
Git failures may arrive as generic errors without a direct code.

## Data and access

Settings and the model cache use the Electron user data folder.
omp owns its accounts and session files.
The selected workspace contains the local plans.

Reviewers use read-only tools without extensions.
Optional login sharing uses a local auth broker and an SSH tunnel.
The remote host gets short-lived access tokens.
Long-lived refresh tokens stay on the Mac.
