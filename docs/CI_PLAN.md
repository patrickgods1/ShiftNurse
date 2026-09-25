# CI/CD plan: GitHub Actions checks and release builds (M16)

> **Where this lives:** `docs/CI_PLAN.md`, tracked in `ROADMAP.md` as
> **M16 — CI/CD and GitHub releases**. Tick a box only when the work has landed **and** its check
> has passed. Each phase ends in its own commit and push. Phases 1–2 are done on the branch
> `ci/github-actions` so the workflows can prove themselves before they guard `main`.

## Context
Today every check runs by hand on one Mac. `npm run check` runs in the pre-commit hook; installers
come from a local `npm run dist`; the Windows installer has never been launched; the x64 mac app has
only been smoke-tested under Rosetta. The one existing workflow, `.github/workflows/cpsat-runner.yml`,
only builds the CP-SAT runner.

Goal:
1. **CI** on every push and pull request.
2. **Release builds on GitHub.** Pushing a `vX.Y.Z` tag builds and smoke-tests the mac arm64, mac
   x64 and Windows x64 installers natively and attaches them to a **draft** GitHub release.

Decisions made:
- **Unsigned for now.** Release notes explain the Gatekeeper and SmartScreen steps. The workflow
  leaves a clearly marked place for signing secrets later.
- **Draft release.** You review it and press Publish.
- **CI scope.** Tests run on Linux, macOS and Windows. Lint and typecheck run on Linux.
- **Branch protection.** `main` requires CI to pass before a merge (admins not enforced).

## Constraints discovered
- **One job per platform.** A mac `.app` contains symlinked frameworks and executable bits, and
  `actions/upload-artifact` preserves neither. So each platform job builds *and* smoke-tests its
  own app, and uploads only the finished `.dmg`/`.exe`.
- **Stop electron-builder publishing on its own.** It auto-publishes when it sees CI, a tag and a
  token, so every CI build passes `--publish never`. A separate job creates the draft release.
- **Lint only on Linux.** Windows runners check out with CRLF (`core.autocrlf=true`), so Biome's
  format check would fail there.
- **The runner fetch's `tar` on Windows.** `fetch-cpsat.mjs` calls `tar` from PATH. On Windows,
  Git's GNU tar can win and misreads `C:\…` as a remote host, so the script calls Windows' own
  `%SystemRoot%\System32\tar.exe` (bsdtar).
- **No runner on Linux.** There is no Linux CP-SAT runner. `postinstall` only warns and the
  real-runner tests skip, which is fine for CI on Linux. On macOS and Windows those tests run
  against the real runner, which is the first time the Windows runner is exercised outside its
  own smoke model.
- **The AI review stays local.** The pre-commit AI review (`claude -p`) needs an API key and is
  not reproduced in CI. CI runs the deterministic gate (lint, typecheck, test).

---

## Phase 0 — Adopt the plan
- [x] 0.1 Copy this file to `docs/CI_PLAN.md`.
- [x] 0.2 Add **M16 — CI/CD and GitHub releases** to `ROADMAP.md`, linking here, with its phases
      as unchecked boxes.
- [x] 0.3 **Commit & push to `main`:** "Plan M16: CI/CD and GitHub release builds".

## Phase 1 — CI on every push and pull request (branch `ci/github-actions`)
- [ ] 1.1 `git checkout -b ci/github-actions`.
- [ ] 1.2 `.github/workflows/ci.yml`:
  - Triggers: `push` to `main`, `pull_request`, and `workflow_dispatch`.
  - `concurrency` cancels superseded runs on the same ref. `permissions: contents: read`.
  - Job **`lint-typecheck`** (ubuntu-latest): `actions/checkout@v4`,
    `actions/setup-node@v4` (Node 22, `cache: npm`), `npm ci`, `npm run lint`,
    `npm run typecheck`.
  - Job **`test`**, a matrix of `ubuntu-latest`, `macos-15` and `windows-2022` (`fail-fast: false`):
    `npm ci` (its `postinstall` fetches the pinned CP-SAT runner on mac/win),
    `npm run build:packages` (desktop tests import core/db from `dist`), then `npm test`.
  - Job names stay fixed (`lint-typecheck`, `test (ubuntu-latest)`, …) because branch protection
    refers to them.
- [ ] 1.3 `apps/desktop/scripts/fetch-cpsat.mjs`: on `win32`, run
      `${process.env.SystemRoot}\System32\tar.exe`, and fall back to `tar` only if it is missing.
      The comment gives the GNU-tar reason.
- [ ] 1.4 Push the branch. Fix anything platform-specific CI turns up (Windows paths, line
      endings in test fixtures, timing), each with its root cause in the commit message.
- [ ] 1.5 All four jobs are green. Record in this file how long each took.
- [ ] 1.6 **Commit & push to `ci/github-actions`:** "Add CI: lint, typecheck and tests on
      Linux, macOS and Windows".

## Phase 2 — Release builds from a version tag (branch `ci/github-actions`)
- [ ] 2.1 `.github/workflows/release.yml`:
  - Triggers: `push` of tags `v*` (this does not match `cpsat-runner-v*`, which starts with `c`),
    and `workflow_dispatch` (a dry run that builds and smoke-tests but publishes nothing).
  - Job **`version`** (ubuntu): fails unless the tag equals `v` + the `version` in both
    `package.json` and `apps/desktop/package.json`. Outputs the version.
  - Job **`build`**, a matrix with each installer built and smoke-tested natively:
    | target | runner | command |
    |---|---|---|
    | mac-arm64 | `macos-15` | `npm run dist -w @shiftnurse/desktop -- --mac --arm64 --publish never` |
    | mac-x64 | `macos-15-intel` | `… -- --mac --x64 --publish never` |
    | win-x64 | `windows-2022` | `… -- --win --x64 --publish never` |
  - Each `build` job runs, in order:
    1. `npm ci`, `npm run build:packages`, `npm run build -w @shiftnurse/desktop`, then the
       `dist` command from the table.
    2. `npm run smoke:packaged -w @shiftnurse/desktop` with `SHIFTNURSE_SMOKE_TIMEOUT_MS=600000`
       and `SHIFTNURSE_SMOKE_SCREENSHOT` set.
    3. Upload the installer, its `.blockmap`, and the smoke screenshot as artifacts.
  - `CSC_IDENTITY_AUTO_DISCOVERY=false` keeps the unsigned build deterministic. A commented
    `env:` block names the future signing secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
    `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`).
  - Job **`release`** (ubuntu, tags only, `permissions: contents: write`, `needs: [version, build]`):
    - Downloads every artifact and writes `SHA256SUMS`.
    - Runs `gh release create vX.Y.Z --draft --title "ShiftNurse X.Y.Z"
      --notes-file` with the rendered notes, attaching the installers, blockmaps and `SHA256SUMS`.
- [ ] 2.2 `.github/release-notes.md`, the template the release job renders with the version:
  - What to download for which machine.
  - The unsigned-app steps:
    - macOS: right-click › Open, or `xattr -dr com.apple.quarantine /Applications/ShiftNurse.app`
      if macOS says the app is damaged.
    - Windows: SmartScreen › More info › Run anyway.
  - How to verify `SHA256SUMS`, and a link to the solver benchmark.
- [ ] 2.3 Run the dry run (`gh workflow run release.yml --ref ci/github-actions`). All three
      builds and smoke runs are green. Download and inspect the artifacts: the file names follow
      `ShiftNurse-<version>-<os>-<arch>.<ext>`, and the dmg mounts locally.
  - The Windows smoke is the **first launch of the packaged Windows app** (a CI VM, not real
    hardware). It also covers the Windows CP-SAT runner doing real solves.
  - The mac x64 smoke runs natively on Intel, not under Rosetta.
- [ ] 2.4 **Commit & push to `ci/github-actions`:** "Build and smoke-test installers on GitHub
      and attach them to a draft release".
- [ ] 2.5 Open a PR to `main`. CI runs on the PR itself and is green. Merge.

## Phase 3 — Protect `main` and cut the first release (on `main`)
- [ ] 3.1 Branch protection on `main` through `gh api`:
  - Required checks: `lint-typecheck`, `test (ubuntu-latest)`, `test (macos-15)` and
    `test (windows-2022)`, set to "up to date before merging".
  - `enforce_admins: false`, so direct maintenance pushes stay possible, and no required reviews.
- [ ] 3.2 Confirm it: a PR shows the four required checks, and `gh api …/protection` echoes them.
- [ ] 3.3 Tag `v0.1.0` (the current version in both `package.json` files) and push the tag. The
      release workflow produces a **draft** release with 3 installers, 3 blockmaps and
      `SHA256SUMS`, and nothing is public until you press Publish.
- [ ] 3.4 Download the draft's mac arm64 dmg and check it against `SHA256SUMS`. It installs,
      launches and generates a schedule on this Mac.

## Phase 4 — Docs (on `main`)
- [ ] 4.1 `README.md`:
  - CI status badge.
  - A **Continuous integration** section: what runs where, and why lint is Linux-only.
  - A **Releasing** section: bump both `version` fields, then `git tag vX.Y.Z && git push
    origin vX.Y.Z`, then review and publish the draft. The dry run is `gh workflow run
    release.yml`.
  - Update the "Compiling executables" notes (local `dist` still works).
- [ ] 4.2 `CLAUDE.md`: Current state (M16 workflows); conventions for the release version check,
      `--publish never`, native per-platform builds, the fixed CI job names branch protection
      depends on, and the Windows `tar` pin.
- [ ] 4.3 `ARCHITECTURE.md` › Packaging trade-offs: installers are built natively per platform
      in CI rather than cross-built from one Mac, and why (native smoke tests, and mac bundles
      not surviving artifact upload).
- [ ] 4.4 `ROADMAP.md`:
  - Tick M16.
  - The M14 Windows item stays open (a CI VM is not real Windows 11 hardware), but record that
    the packaged app now boots and solves on `windows-2022` in CI.
- [ ] 4.5 **Commit & push to `main`:** "Document CI and the release process (M16)". CI is green
      on the push.

## Verification (end to end)
- CI: the four jobs are green on the branch, on the PR and on `main`. A deliberately failing
  change on a throwaway PR is blocked from merging, and is then closed.
- Release dry run: three native builds, each passing `smoke:packaged` (every solver, regenerate
  identical), with installers uploaded as artifacts.
- Tagged release: a draft release for `v0.1.0` with correct file names and a `SHA256SUMS` that
  verifies. One installer is installed and launched locally.
- Nothing is published publicly without your review; the draft stays a draft.
