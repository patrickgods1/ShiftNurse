# ShiftNurse

[![ci](https://github.com/patrickgods1/ShiftNurse/actions/workflows/ci.yml/badge.svg)](https://github.com/patrickgods1/ShiftNurse/actions/workflows/ci.yml)
[![release](https://github.com/patrickgods1/ShiftNurse/actions/workflows/release.yml/badge.svg)](https://github.com/patrickgods1/ShiftNurse/actions/workflows/release.yml)

A local desktop app (Electron, Windows 11 + macOS) that builds nurse unit schedules. It
generates a union/contract-compliant schedule for a scheduling period, scores the result for
fairness across the team, prices it, and — when demand can't be met — presents ranked
resolution options instead of an error.

A nurse manager today builds unit schedules by hand against union/contract rules: slow,
error-prone work where a mistake becomes a grievance. ShiftNurse automates the generation,
lets the manager override it with live rule validation, and handles the downstream lifecycle
(fairness scoring, cost pricing, time-off/exchange conflicts, day-of call-offs, publish +
audit trail) that a schedule goes through in a real unit.

**v1 is manager-only.** Nurses do not log in — every request (time off, shift exchange,
pickup) is modelled as *a request with a submitter and a decider*, with v1 always setting
`enteredBy: 'manager'`. That seam is deliberate: nurse self-service later becomes an intake
surface on the same data model, not a rewrite.

**Status:** pre-1.0. All 14 roadmap milestones are built; the macOS build is verified end to
end, the Windows installer builds but has not yet been launched on real Windows 11 hardware.

See [ROADMAP.md](ROADMAP.md) for the full plan of record (locked-in decisions, milestone
detail, verification steps) and [CLAUDE.md](CLAUDE.md) for the conventions and invariants
this codebase is held to. This document is the practical "how do I build/run/ship it" guide;
[ARCHITECTURE.md](ARCHITECTURE.md) covers the "why is it built this way."

## Features

- **Schedule generation** — three selectable solvers produce a full-period schedule under hard
  union/contract rules: **Hybrid** (the default: simulated annealing with Google OR-Tools'
  CP-SAT re-optimising the hardest few days exactly), **SA + LNS** (pure TypeScript, always
  available) and **CP-SAT** over the whole period. Settings › Solver picks the unit's default;
  the Generate dialog can override it for one run. See [docs/solver-bench.md](docs/solver-bench.md)
  for how they compare. A manual drag-and-drop grid with live violation badges handles edits
  afterward.
- **Rule engine** — rest periods, consecutive-shift limits, contracted hours/FTE, credential
  and skill coverage, patient-ratio compliance. Rules are data plus a small evaluator, so a
  new contract clause is a new rule, not new solver code.
- **Acuity-driven demand** — coverage floors, acuity tiers/ratios/HPPD, a same-weekday
  moving-average forecaster with seasonal index and back-test, and a census grid.
- **Fairness scoring** — per-nurse and unit-wide distribution of nights, weekends, holidays,
  on-call and denied requests, weighted by seniority, with trend history.
- **Cost & pricing** — pay rates, shift differentials, overtime rules, budget-vs-actual and
  overtime-concentration reporting, and a running cost strip while editing the grid.
- **Time off, conflicts & exchanges** — a conflict-detection engine simulates every request
  against the schedule, ranks resolution options, supports policy-driven auto-resolve with an
  audit trail, and evaluates 1:1 trades and giveaways for hard-rule and fairness impact.
- **Publish lifecycle** — versioned publishes, a reasoned post-publish change log, compliance
  alerts, PDF/CSV/xlsx export, and scheduled backups via SQLite's online backup API.
- **Day-of console** — call-off handling with a ranked replacement finder and live
  re-staffing check against the current census.
- **CSV import/export** for roster and history data, and a demo dataset seeded on first
  launch.

## Prerequisites

- **Node.js ≥ 22.12** (see `engines` in [package.json](package.json); `.nvmrc` pins the major CI uses).
- **npm** — this is an npm-workspaces monorepo. Do not introduce a pnpm lockfile; pnpm is
  intentionally not used here (see [CLAUDE.md](CLAUDE.md#conventions)).
- A C/C++ toolchain capable of building native Node modules (`better-sqlite3` ships
  prebuilds for common platforms, but npm may need to compile it if none matches):
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`).
  - **Windows**: Visual Studio Build Tools with the "Desktop development with C++" workload.
- Git.

## Developer setup

```bash
git clone https://github.com/patrickgods1/ShiftNurse.git
cd ShiftNurse
npm install
```

`npm install` runs the `prepare` script, which points git at the repo's hooks
(`.githooks/`) — see [Git hooks](#git-hooks) below — and a `postinstall` step in
`apps/desktop` that rebuilds `better-sqlite3` for Electron's ABI
(`scripts/rebuild-sqlite-for-electron.mjs`) and downloads the CP-SAT runner for this machine
into `apps/desktop/.cpsat/host` (`scripts/fetch-cpsat.mjs`). The download needs network access;
offline it only warns, and the app falls back to SA + LNS until
`npm run fetch:cpsat -w @shiftnurse/desktop` succeeds.

Then see [Launching the app](#launching-the-app).

## File structure

```
packages/core/     # Pure TypeScript domain: rules, acuity, solver, fairness, cost,
                    # conflicts, exchange, publish, day-of. No Electron, no database, no I/O.
native/cpsat-runner/ # C++ CP-SAT runner linked against OR-Tools, built by CI (see below).
packages/db/        # Drizzle schema (31 tables) + migrations + repositories over
                    # better-sqlite3. Owned by the Electron main process only.
apps/desktop/       # Electron app.
  src/shared/api.ts   #   The IPC contract (ShiftNurseApi, API_CHANNELS) — read this first.
  src/main/           #   Opens the DB, implements the IPC contract, runs the solver in a
                      #   worker thread (spawning the CP-SAT runner for CP-SAT/hybrid),
                      #   handles backups/output/print/xlsx.
  src/preload/        #   Exposes window.shiftnurse from the same channel table (CommonJS).
  src/renderer/src/   #   React 18 + TanStack Router/Query + Tailwind v4. Routes: Dashboard,
                      #   Today, Schedule (grid, generate, publish, export), Demand, Fairness,
                      #   Roster, Requests (time off + exchanges), Settings (shift types,
                      #   coverage, acuity, holidays, rules, pay, solver, conflicts, backups).
.claude/             # Claude Code skills, agents and hooks used while developing this repo.
.githooks/           # pre-commit (fast gate + AI review) and prepare-commit-msg.
ROADMAP.md           # Plan of record: milestones, locked-in decisions, verification steps.
CLAUDE.md            # Architecture and conventions for anyone (human or AI) working here.
ARCHITECTURE.md      # Why this stack, trade-offs considered.
docs/                # SOLVER_PLAN.md (M15 plan), CI_PLAN.md (M16 plan) and solver-bench.md (benchmark results).
```

Each package/app has its own `package.json`, `tsconfig.json`, and (for `core`/`db`) a
`dist/` build output — see [Architecture](#architecture-overview) below for how they compose.

## Commands

Run from the repo root unless noted.

| Command | What it does |
|---|---|
| `npm run dev` | Builds packages, then runs package watchers + `electron-vite dev` with HMR. |
| `npm test` | `vitest run` over `packages/*/src/**/*.test.ts`, renderer tests, and `apps/desktop/src/main/**/*.test.ts`. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run test:coverage` | Tests with v8 coverage (`packages/*` and the desktop main process). |
| `npm run lint` | `biome check .` — format + lint, no writes. |
| `npm run lint:fix` | `biome check --write .`. |
| `npm run format` | `biome format --write .`. |
| `npm run typecheck` | Builds `core` and `db`, then `tsc --build --force` against the root `tsconfig.json` (every package **including test files**), then the desktop's own `tsc --noEmit` over its `tsconfig.node.json` and `tsconfig.web.json`. |
| `npm run check` | lint + typecheck + test — the full gate CI runs. |
| `npm run build:packages` | Builds `core` then `db` with `tsc`. `dev`, `build` and `seed:demo` run it for you; run it by hand after touching core before trusting a smoke result. |
| `npm run seed:demo` | Builds and runs the demo seeder into a standalone `packages/db/demo.sqlite` (optional; the app seeds its own DB). `-- --force` overwrites, `-- --seed <n>` changes the RNG seed. |
| `npm run build` | Production bundle into `apps/desktop/out` (via `electron-vite build`). |
| `npm run dist` | Builds, then packages installers with electron-builder (see [Compiling executables](#compiling-executables)). |
| `npm run smoke -w @shiftnurse/desktop` | Builds and boots the real app headlessly against a temp `userData`, asserts the preload bridge and dashboard rendered. `-- --screenshot <png>` captures the window. Run after touching main/preload/IPC. |
| `npm run smoke:packaged -w @shiftnurse/desktop` | Same, but boots the packaged `.app`/`.exe` from `release/`. Run after any packaging change. With the CP-SAT runner installed the smoke run generates with every solver twice and takes a few minutes; an emulated x64 run on Apple silicon may need `SHIFTNURSE_SMOKE_TIMEOUT_MS=900000`. |
| `npm run bench:solvers` | Runs every solver on the demo and two fixture units at three seeds and writes [docs/solver-bench.md](docs/solver-bench.md). Needs the CP-SAT runner; takes several minutes. Not part of `npm test`. |
| `npm run fetch:cpsat -w @shiftnurse/desktop` | Downloads the pinned CP-SAT runner for this machine into `apps/desktop/.cpsat/host` (fails loudly, unlike the `postinstall` step). |

## Running tests

```bash
npm test
```

This runs every `*.test.ts` under `packages/*/src`, `apps/desktop/src/renderer/src`, and
`apps/desktop/src/main` in one Vitest pass (see [vitest.config.ts](vitest.config.ts)). For
iterative work:

```bash
npm run test:watch
```

Before opening a pull request, run the full gate (CI enforces it; the pre-commit hook runs a
faster subset):

```bash
npm run check   # lint + typecheck + test
```

`packages/core` follows test-first development for domain logic (rules, solver, fairness,
acuity, cost) — write the failing test, watch it fail, then make it pass. See
[CLAUDE.md](CLAUDE.md#development-discipline) for why this matters here specifically:
scheduling bugs are silent (a rule that never fires, an off-by-one in a rest calculation) —
they don't crash, they produce a schedule that *looks* plausible and is wrong.

UI/IPC changes should also be exercised by hand: launch with `npm run dev` and click through
the affected page, and/or run the smoke script (`npm run smoke -w @shiftnurse/desktop`),
since unit tests can't see a preload that never ran or a wrong-ABI native module.

## Launching the app

Development, with hot reload:

```bash
npm run dev
```

This builds `packages/core` and `packages/db`, starts their watchers, and starts
`electron-vite dev`. On first launch the app creates its SQLite database in the OS
`userData` directory and seeds a deterministic demo unit (roster, six months of history)
into it — you do not need to seed anything by hand.

`npm run seed:demo` is separate and optional: it writes a standalone `packages/db/demo.sqlite`
for inspecting the schema with sqlite tooling or reproducing seeder issues. The app never
reads that file. It refuses to overwrite an existing one unless you pass `--force`
(`npm run seed:demo -- --force`).

> **VS Code integrated terminal note:** VS Code exports `ELECTRON_RUN_AS_NODE`, which turns
> the Electron binary into a bare Node runtime and breaks the app with an error like
> `'electron' does not provide an export named 'BrowserWindow'`. Run `unset
> ELECTRON_RUN_AS_NODE` before `npm run dev` in that terminal (the smoke and dist scripts do
> this automatically).

## Continuous integration

GitHub Actions runs [`ci.yml`](.github/workflows/ci.yml) on every push to `main` and every pull
request:

| Job | Runs on | What |
|---|---|---|
| `lint-typecheck` | ubuntu-latest | `npm run lint`, `npm run typecheck`, `npm audit --omit=dev --audit-level=high` |
| `test (…)` | ubuntu-latest, macos-15, windows-2022 | `npm run build:packages`, `npm test` — on macOS and Windows against the real CP-SAT runner, which `npm ci` fetches; on ubuntu with coverage, summarised on the run page |

`main` is protected: a pull request merges only when those four checks pass (admins may still
push directly). Lint runs on Linux only because Windows checks out with CRLF line endings, which
Biome's format check would flag in every file. The pre-commit AI review stays local.

All workflows set up through one composite action, [`.github/actions/setup`](.github/actions/setup/action.yml),
pin third-party actions by commit SHA, and set a timeout on every job. Dependabot opens weekly
grouped updates for npm and for the actions themselves.

## Releasing

1. Bump `version` in **both** `package.json` and `apps/desktop/package.json` (the release
   workflow refuses a tag that does not match both), merge to `main`.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. [`release.yml`](.github/workflows/release.yml) builds each installer **natively** — mac arm64
   on `macos-15`, mac x64 on `macos-15-intel`, Windows x64 on `windows-2022` — and boots each
   packaged app in smoke mode, **from a copy outside the repo**, generating with every solver and
   running publish, exports and the day-of console. Then it creates a **draft** GitHub release
   with the three installers, their blockmaps and `SHA256SUMS`, and notes from
   [`.github/release-notes.md`](.github/release-notes.md).
4. Review the draft (download an installer, check it against `SHA256SUMS`, install it) and press
   **Publish**. Nothing is public before that.

A dry run (the same builds and smoke tests, no release) runs on any pull request that touches
packaging, or by hand: `gh workflow run release.yml`. Builds are **unsigned** for now — the
release notes explain macOS Gatekeeper's and Windows SmartScreen's one-time "open anyway" steps,
and the workflow lists (commented out) the secrets that signing will need.

## Compiling executables

Production bundle only (no installer):

```bash
npm run build
```

Full installers via [electron-builder](apps/desktop/electron-builder.yml):

```bash
npm run dist
```

From macOS this builds a macOS DMG (x64 + arm64). Windows installers can be cross-built from
macOS with the explicit workspace form so extra flags reach electron-builder:

```bash
npm run dist -w @shiftnurse/desktop -- --win --x64
```

Notes:

- Electron is pinned to an exact version — electron-builder refuses a version range.
- `electron-builder.yml` sets `npmRebuild: false`. electron-builder's default native-module
  rebuild would recompile the repo's hoisted `better-sqlite3` for Electron's ABI, which
  breaks `npm test`/the seeder afterward. Instead `apps/desktop/scripts/before-pack.mjs`
  fetches the correct prebuild for each **target** platform/arch, and
  `apps/desktop/scripts/dist.mjs` restores the host (Node-ABI) binary in a `finally` block
  regardless of build outcome.
- `before-pack.mjs` also fetches the **CP-SAT runner** for each target from the pinned
  `cpsat-runner-v*` GitHub release (checked against the SHA-256 in
  `apps/desktop/scripts/fetch-cpsat.mjs`) into `apps/desktop/.cpsat/target`, which
  `electron-builder.yml` ships as `resources/cpsat`. A failed fetch fails the build — an
  installer without it would silently lose two solvers. The runner and its OR-Tools libraries
  add roughly 50 MB unpacked (~20 MB compressed) per platform.
- A local `npm run dist` builds both mac dmgs on this machine (and can cross-build Windows);
  release builds are made per platform in CI instead (see [Releasing](#releasing)).
- `npm run smoke:packaged` runs a **copy of the app outside the repo** and passes only on the
  app's final `[smoke] PASS` line. Inside the repo, Node would find a module the app forgot to
  ship in the repo's own `node_modules`, and a crash-on-launch dialog exits 0 when dismissed —
  both let v0.1.0's first draft pass here and crash on every real install.
- Installers are unsigned initially, so expect Gatekeeper (macOS) / SmartScreen (Windows)
  warnings — code signing is planned for later.
- After any packaging-related change, run `npm run smoke:packaged -w @shiftnurse/desktop` to
  boot the actual built binary and catch what unit tests structurally can't (a missing
  migration file, a wrong-ABI native module).

## The CP-SAT runner

OR-Tools has no JavaScript bindings, so CP-SAT runs in a small C++ program,
[`native/cpsat-runner`](native/cpsat-runner/README.md), that the app spawns and talks to over
stdin/stdout (JSON lines defined in `runner.proto`). The app never compiles it:

- **CI** ([`.github/workflows/cpsat-runner.yml`](.github/workflows/cpsat-runner.yml)) builds it
  for macOS arm64 (`macos-15`), macOS x64 (`macos-15-intel`) and Windows x64 on every push that
  touches `native/cpsat-runner/`, and checks each build solves a hand-worked model.
- **Releasing a new runner**: push a tag `cpsat-runner-vN`. CI publishes
  `cpsat-runner-<platform>-<arch>.tar.gz` and `SHA256SUMS` as a GitHub release. Then update
  `RUNNER_TAG` and the three hashes in `apps/desktop/scripts/fetch-cpsat.mjs` and run
  `npm run fetch:cpsat -w @shiftnurse/desktop`.
- **Building locally** (only needed to change the runner): `brew install cmake`, download the
  OR-Tools C++ archive and build with CMake — the exact commands are in
  [native/cpsat-runner/README.md](native/cpsat-runner/README.md).
- **Bumping OR-Tools**: change the version and the two `.proto` hashes in
  `native/cpsat-runner/CMakeLists.txt` and the archive names in the workflow, then cut a new
  `cpsat-runner-v*` tag.

## Credits and references

### Solvers and libraries ShiftNurse ships

- **[Google OR-Tools](https://developers.google.com/optimization) and its CP-SAT solver**
  (Apache-2.0) power the CP-SAT and hybrid solvers, through the C++ runner in
  [native/cpsat-runner](native/cpsat-runner/README.md). Please cite them as the OR-Tools
  project asks ([how to cite](https://developers.google.com/optimization/support/cite)):
  - Laurent Perron and Vincent Furnon. *OR-Tools*, v9.15. Google.
    https://developers.google.com/optimization/
  - Laurent Perron and Frédéric Didier. *CP-SAT*, v9.15. Google.
    https://developers.google.com/optimization/cp/cp_solver/
  - Laurent Perron, Frédéric Didier and Steven Gay. "The CP-SAT-LP Solver." *CP 2023*, LIPIcs
    280, 3:1–3:2. [doi:10.4230/LIPIcs.CP.2023.3](https://doi.org/10.4230/LIPIcs.CP.2023.3)
- The runner bundles OR-Tools' own dependencies — Abseil, Protocol Buffers, RE2, HiGHS, SCIP,
  SoPlex, COIN-OR CBC/CLP, Eigen, zlib, bzip2 and, on Windows, the Microsoft Visual C++
  runtime. Each keeps its licence; see
  [native/cpsat-runner/THIRD_PARTY_NOTICES.md](native/cpsat-runner/THIRD_PARTY_NOTICES.md), and
  every installer carries the full texts in `resources/cpsat/licenses/`.
- **mulberry32**, the seeded random-number generator behind the solvers' determinism
  (`packages/core/src/solver/rng.ts`), is by Tommy Ettinger and in the public domain
  ([original](https://gist.github.com/tommyettinger/46a874533244883189143505d203312c)).
- The app is built on [Electron](https://www.electronjs.org), [React](https://react.dev),
  [TanStack Router and Query](https://tanstack.com), [Radix UI](https://www.radix-ui.com),
  [Tailwind CSS](https://tailwindcss.com), [Drizzle ORM](https://orm.drizzle.team) over
  [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) and SQLite,
  [electron-vite](https://electron-vite.org), [electron-builder](https://www.electron.build),
  [Vitest](https://vitest.dev) and [Biome](https://biomejs.dev); CI uses
  [ilammy/msvc-dev-cmd](https://github.com/ilammy/msvc-dev-cmd) for the Windows runner build.

### Research the solvers draw on

The solver design (M15, [docs/SOLVER_PLAN.md](docs/SOLVER_PLAN.md)) follows published work on
the nurse rostering problem and on the local-search methods it uses:

1. S. Kirkpatrick, C. D. Gelatt Jr. and M. P. Vecchi. "Optimization by simulated annealing."
   *Science* 220(4598):671–680, 1983. [doi:10.1126/science.220.4598.671](https://doi.org/10.1126/science.220.4598.671)
   — the annealing at the core of SA + LNS and the hybrid.
2. G. Schrimpf, J. Schneider, H. Stamm-Wilbrandt and G. Dueck. "Record breaking optimization
   results using the ruin and recreate principle." *Journal of Computational Physics*
   159(2):139–171, 2000. [doi:10.1006/jcph.1999.6413](https://doi.org/10.1006/jcph.1999.6413)
   — the ruin-and-recreate move.
3. S. Ceschia, R. Guido and A. Schaerf. "Solving the static INRC-II nurse rostering problem by
   simulated annealing based on large neighborhoods." *Annals of Operations Research*
   288:95–113, 2020. [doi:10.1007/s10479-020-03527-6](https://doi.org/10.1007/s10479-020-03527-6)
   — the two-nurse multi-day block moves (`solver/block-moves.ts`).
4. S. Ceschia, N. Dang, P. De Causmaecker, S. Haspeslagh and A. Schaerf. "The Second
   International Nurse Rostering Competition." *Annals of Operations Research* 274(1):171–186,
   2019. [doi:10.1007/s10479-018-2816-0](https://doi.org/10.1007/s10479-018-2816-0); problem
   description [arXiv:1501.04177](https://arxiv.org/abs/1501.04177) — the benchmark the
   literature comparison rests on.
5. A. Legrain and J. Omer. "A dedicated pricing algorithm to solve a large family of nurse
   scheduling problems with branch-and-price." *INFORMS Journal on Computing* 36(4):1108–1128,
   2024. [doi:10.1287/ijoc.2023.0019](https://doi.org/10.1287/ijoc.2023.0019) — the
   state of the art for exact methods, weighed against CP-SAT and the hybrid.
6. C. Valouxis, C. Gogos, G. Goulas, P. Alefragis and E. Housos. "A systematic two phase
   approach for the nurse rostering problem." *European Journal of Operational Research*
   219(2):425–433, 2012. [doi:10.1016/j.ejor.2011.12.042](https://doi.org/10.1016/j.ejor.2011.12.042)
   — the INRC-I winner, and the case for mixing exact sub-problems into local search.
7. E. K. Burke and T. Curtois. "New approaches to nurse rostering benchmark instances."
   *European Journal of Operational Research* 237(1):71–81, 2014.
   [doi:10.1016/j.ejor.2014.01.039](https://doi.org/10.1016/j.ejor.2014.01.039)

## Git hooks

Installed automatically by `npm install` (`prepare` script points git at `.githooks/`):

- **`pre-commit`** — a fast gate (Biome on the staged files, incremental typecheck, the tests
  related to the staged files; a few seconds), then sends the staged diff to a headless Claude
  reviewer briefed on this repo's invariants; a `VERDICT: BLOCK` aborts the commit with
  findings printed. The reviewer needs the `claude` CLI on your PATH; without it the hook
  skips the review and keeps the gate. `FULL_CHECK=1 git commit …` runs the full
  `npm run check` instead; `SKIP_REVIEW=1 git commit …` skips the review;
  `git commit --no-verify` skips both (avoid unless you have a specific reason).
- **`prepare-commit-msg`** — drafts a commit message from the staged diff for a bare `git
  commit` (never touches a message given with `-m`/`-F`).

## Architecture overview

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full write-up. In short: `packages/core` is a
pure-TypeScript domain package with zero Electron/database/filesystem dependencies, so it can
be re-hosted behind a future web/mobile backend unchanged. `packages/db` owns all persistence
(Drizzle + better-sqlite3) and is only ever imported by the Electron main process.
`apps/desktop`'s renderer never touches the database directly — it goes through a typed IPC
surface (`src/shared/api.ts`) deliberately shaped like the eventual HTTP API.

## Contributing / working in this repo

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, and [CHANGELOG.md](CHANGELOG.md) for
what changed in each release.

If you're using Claude Code in this repository, start with [CLAUDE.md](CLAUDE.md) — it
documents the conventions, invariants (especially the wall-clock time model in
`packages/core/src/domain/time.ts`), and the skills/hooks set up under `.claude/`.
