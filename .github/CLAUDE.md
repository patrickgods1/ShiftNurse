# .github

> Loaded automatically when Claude works on files under this folder. Cross-cutting rules live in the root `CLAUDE.md`.

## M16 — CI/CD

- **M16 — CI/CD** (complete; plan `docs/CI_PLAN.md`): `.github/workflows/ci.yml` (lint +
  typecheck on Linux; tests on ubuntu/macos-15/windows-2022) guards `main` through branch
  protection; `.github/workflows/release.yml` builds each installer natively on a `vX.Y.Z` tag,
  smoke-tests it, and creates a **draft** release (`.github/release-notes.md`); it dry-runs on PRs
  touching packaging. Builds are unsigned.

`npm test` runs two Vitest projects: `unit` in parallel, then `solver-heavy` (full-solve files) one file at a time. `npm run test:coverage` runs tests with v8 coverage over `packages/*` and desktop `main`; CI's ubuntu leg posts a per-area table (`scripts/coverage-summary.mjs`) to the run summary. Coverage scales test timeouts 3× (config sets `COVERAGE=1`; explicit ones use `slow()`); CI's macOS leg sets `SHIFTNURSE_REQUIRE_CPSAT=1`, so a missing CP-SAT runner fails the cpsat tests instead of skipping them.

## Conventions

- **CI job names are load-bearing.** Branch protection on `main` requires `lint-typecheck`,
  `test (ubuntu-latest)`, `test (macos-15)` and `test (windows-2022)` by name; renaming a job
  means updating the protection rule too. A release tag must equal `v` + both `package.json`
  versions. Release builds pass `--publish never` (electron-builder would otherwise publish on
  its own when it sees CI + tag + token) and name their target explicitly (`--mac dmg --arm64`):
  `electron-builder.yml` lists both mac archs, which overrides a bare `--arm64` and once made each
  mac job build — and upload — an untested copy of the other arch's dmg.
- **Workflows share `.github/actions/setup`** (Node from `.nvmrc`, npm + download caches,
  `npm ci`, `build:packages`). Every third-party action is pinned to a commit SHA with a
  `# vX.Y.Z` comment; Dependabot (`.github/dependabot.yml`) bumps both. Every job has a
  `timeout-minutes`. The OR-Tools archive the runner links against is checked against a
  per-matrix `sha256` (GitHub's asset digest) whether downloaded or cached.
  `lint-typecheck` installs with `--ignore-scripts` and fails on a high-severity advisory in a
  runtime dependency (`npm audit --omit=dev`).
