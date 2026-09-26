# Contributing

ShiftNurse is a scheduling tool whose mistakes are quiet: a rule that never fires still produces
a schedule that looks fine. Most of what follows exists to make those mistakes loud.

## Before you start

- Read [CLAUDE.md](CLAUDE.md), especially the time model (`packages/core/src/domain/time.ts`)
  and the boundary rule: `packages/core` imports nothing from Electron or the database.
- Setup, commands and the release process are in [README.md](README.md).
  `npm install` also wires the git hooks.

## Making a change

- Work on a branch and open a pull request into `main`. `main` requires the four CI checks
  (`lint-typecheck` and `test` on Ubuntu, macOS and Windows).
- In `packages/core`, write the failing test first and watch it fail. Name tests for the
  real-world situation ("flags the night-to-day turnaround"), and take expected values from
  hand working, not from re-running the implementation's arithmetic.
- `npm run check` (lint, typecheck, all tests) is the gate. Run it before pushing; CI runs it on
  three platforms.
- After touching the main process, preload or IPC, run `npm run smoke -w @shiftnurse/desktop`:
  unit tests cannot see a preload that never ran or a native module built for the wrong ABI.
- Performance work in the solver must not change a schedule. Hash its output on fixed inputs
  before and after (see "Solver speed-ups must not change a schedule" in CLAUDE.md).

## The pre-commit hook

It runs Biome on the staged files, an incremental typecheck and the tests related to the staged
files, then an AI review of the staged diff (needs the `claude` CLI; skipped without it).
- `FULL_CHECK=1 git commit …` runs the full `npm run check` instead.
- `SKIP_REVIEW=1 git commit …` skips only the review.
- `git commit --no-verify` skips everything. Avoid it: CI will run the same checks anyway.

## User-visible changes

Add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md), written for a nurse manager,
not a developer.
