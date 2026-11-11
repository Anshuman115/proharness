# Development

## Setup

Use macOS 13 or later on Apple silicon.
Use Node.js 22.12.0 or later, Git, and the pnpm version in the [package manifest](<../package.json>).
Install omp from [the omp site](https://omp.sh).
Sign in to a provider through omp.

Run these commands from the repository root:

```sh
pnpm install
pnpm dev
```

## Checks

Run the offline tests:

```sh
pnpm test
```

Run the TypeScript checks and production build:

```sh
pnpm build
```

Live tests use real model accounts and remote hosts.
Run them only with explicit permission.
Use the live test commands in the root [README](<../README.md#run-from-source>).

## Packaging

Run `pnpm dist:mac` to make the Apple silicon DMG and ZIP files.
The build output uses ad-hoc signing by default.
Keep signing credentials outside the repository.
Use the [builder config](<../electron-builder.yml>) for package settings.
Ad-hoc signing does not provide Apple notarization.

Use a temporary folder outside Documents, Desktop, and Downloads for package tests.
Keep the test app, workspace, and app settings in that folder.
Use a separate `--user-data-dir` for the test app.
Stop the test if macOS repeatedly requests folder access.
Keep macOS permissions unchanged during automated tests.

## Before a commit

1. Run the checks that apply to the change.
2. Run `git diff --check`.
3. Review `git status --short --untracked-files=all`.
4. Check new text and images for personal data and credentials.
5. Stage only the intended files.
6. Review `git diff --cached --stat`.
7. Review `git diff --cached`.

Keep dependencies, build output, local goals, session data, and private keys out of commits.
The [ignore file](<../.gitignore>) excludes common local files.
Git ignore rules do not remove files that Git already tracks.
Review the staged content before each commit.
