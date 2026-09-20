# ShiftNurse

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

- **Schedule generation** — a pure-TypeScript solver (greedy seed + simulated annealing)
  produces a full-period schedule under hard union/contract rules, with a manual
  drag-and-drop grid and live violation badges for edits afterward.
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

- **Node.js ≥ 20** (see `engines` in [package.json](package.json)).
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
(`scripts/rebuild-sqlite-for-electron.mjs`).

Then see [Launching the app](#launching-the-app).

## File structure

```
packages/core/     # Pure TypeScript domain: rules, acuity, solver, fairness, cost,
                    # conflicts, exchange, publish, day-of. No Electron, no database, no I/O.
packages/db/        # Drizzle schema (30 tables) + migrations + repositories over
                    # better-sqlite3. Owned by the Electron main process only.
apps/desktop/       # Electron app.
  src/shared/api.ts   #   The IPC contract (ShiftNurseApi, API_CHANNELS) — read this first.
  src/main/           #   Opens the DB, implements the IPC contract, runs the solver in a
                      #   worker thread, handles backups/output/print/xlsx.
  src/preload/        #   Exposes window.shiftnurse from the same channel table (CommonJS).
  src/renderer/src/   #   React 18 + TanStack Router/Query + Tailwind v4. Routes: Dashboard,
                      #   Today, Schedule (grid, generate, publish, export), Demand, Fairness,
                      #   Roster, Requests (time off + exchanges), Settings (shift types,
                      #   coverage, acuity, holidays, rules, pay, conflicts, backups).
.claude/             # Claude Code skills, agents and hooks used while developing this repo.
.githooks/           # pre-commit (test gate + AI review) and prepare-commit-msg.
ROADMAP.md           # Plan of record: milestones, locked-in decisions, verification steps.
CLAUDE.md            # Architecture and conventions for anyone (human or AI) working here.
ARCHITECTURE.md      # Why this stack, trade-offs considered.
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
| `npm run lint` | `biome check .` — format + lint, no writes. |
| `npm run lint:fix` | `biome check --write .`. |
| `npm run format` | `biome format --write .`. |
| `npm run typecheck` | `tsc --build --force` against the root `tsconfig.json` (every package **including test files**), then the desktop's own `tsc --noEmit` over its `tsconfig.node.json` and `tsconfig.web.json`. |
| `npm run check` | lint + typecheck + test — the pre-commit gate. |
| `npm run build:packages` | Builds `core` then `db` with `tsc`. `dev`, `build` and `seed:demo` run it for you; run it by hand after touching core before trusting a smoke result. |
| `npm run seed:demo` | Builds and runs the demo seeder into a standalone `packages/db/demo.sqlite` (optional; the app seeds its own DB). `-- --force` overwrites, `-- --seed <n>` changes the RNG seed. |
| `npm run build` | Production bundle into `apps/desktop/out` (via `electron-vite build`). |
| `npm run dist` | Builds, then packages installers with electron-builder (see [Compiling executables](#compiling-executables)). |
| `npm run smoke -w @shiftnurse/desktop` | Builds and boots the real app headlessly against a temp `userData`, asserts the preload bridge and dashboard rendered. `-- --screenshot <png>` captures the window. Run after touching main/preload/IPC. |
| `npm run smoke:packaged -w @shiftnurse/desktop` | Same, but boots the packaged `.app`/`.exe` from `release/`. Run after any packaging change. |

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

Before committing, run the full gate (also enforced by the pre-commit hook):

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
- Installers are unsigned initially, so expect Gatekeeper (macOS) / SmartScreen (Windows)
  warnings — code signing is planned for later.
- After any packaging-related change, run `npm run smoke:packaged -w @shiftnurse/desktop` to
  boot the actual built binary and catch what unit tests structurally can't (a missing
  migration file, a wrong-ABI native module).

## Git hooks

Installed automatically by `npm install` (`prepare` script points git at `.githooks/`):

- **`pre-commit`** — runs `npm run check`, then sends the staged diff to a headless Claude
  reviewer briefed on this repo's invariants; a `VERDICT: BLOCK` aborts the commit with
  findings printed. The reviewer needs the `claude` CLI on your PATH; without it the hook
  skips the review and keeps the test gate. `SKIP_REVIEW=1 git commit …` does the same
  explicitly; `git commit --no-verify` skips both (avoid unless you have a specific reason).
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

If you're using Claude Code in this repository, start with [CLAUDE.md](CLAUDE.md) — it
documents the conventions, invariants (especially the wall-clock time model in
`packages/core/src/domain/time.ts`), and the skills/hooks set up under `.claude/`.
