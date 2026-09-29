# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## What this is

ShiftNurse is a local desktop app (Electron, Windows 11 + macOS) that builds nurse unit
schedules. It generates a union/contract-compliant schedule for a scheduling period,
scores the result for fairness across the team, prices it, and when demand can't be met
presents ranked resolution options rather than an error. **v1 is manager-only**: nurses do
not log in, so every request (time off, shift exchange, pickup) is modelled as *a request
with a submitter and a decider* and v1 sets `enteredBy: 'manager'`. That seam is why nurse
self-service later becomes an intake surface rather than a new data model.

## Current state — read this before hunting for files

**`packages/core`**, **`packages/db`** and **`apps/desktop`** exist and are green.

- `packages/core` (M1, complete): `domain/time.ts`, `domain/entities.ts`, `acuity/demand.ts`,
  `schedule/view.ts`, `rules/` (registry + 8 hard rules), `roster/csv.ts` (M4: the one CSV
  parser/formatter), `acuity/forecast.ts` (M5: same-weekday moving average with seasonal
  index, mix validation, back-test), `fairness/` (M7), `cost/` (M8: `resolvePayRate`,
  `costSchedule`, `marginalCost`, `compareToBudget` — the pay model is documented in
  `cost/types.ts`), `solver/` (M9: `types.ts` is the `Solver` contract, `model.ts` the
  incremental state + objective, `greedy.ts` the seed, `anneal.ts` the moves, `solver.ts` the
  entry point, `rng.ts` the seeded mulberry32 shared with the seeder; M15 added
  `registry.ts` (`SolverId`, `FALLBACK_ORDER`, `resolveSolverId`), `report.ts` (the one
  `buildReport` every backend shares), `block-moves.ts` (two-nurse multi-day swaps),
  `hybrid.ts` (`LocalSearch`: chunked annealing + CP-SAT windows) and `cpsat/` — `encode.ts`
  (`SolveInput` → CP-SAT model, `CPSAT_ENCODERS` per rule), `rules/*` the rule encoders,
  `objective.ts`, `builder.ts` (`CpBuilder`, whose `evaluate` prices a schedule without the
  runner), `decode.ts`, `params.ts`, `index.ts` (`prepareCpsat` / `finishCpsat`)), `dayof/` (M13:
  `types.ts` contract, `replacements.ts`,
  `staffing.ts`), `rules/incompatibility-rules.ts` + `schedule/overlap.ts` (incompatible staff),
  `conflicts/` (M10: `types.ts` is the
  contract, `engine.ts` the shared indexes + simulation state, `detect.ts`, `resolve.ts`,
  `analyse.ts`), `exchange/` (M11: `evaluateExchange` / `planExchange` — trade and giveaway
  verdicts `ok | warn | blocked` simulated on the conflicts engine), `publish/` (M12: `diff.ts`
  keyed on nurse/date/shift, `compliance.ts` alerts, `output.ts` grid/nurse-sheet projections
  and CSV), `testing/fixtures.ts`.
- `packages/db` (M2, complete): 31-table Drizzle schema, generated migrations, `client.ts`
  (WAL, foreign keys ON, `transact`), `audit.ts`, `mappers.ts`, and repositories under
  `repositories/` — `roster`, `config` (unit, shift types, coverage, holidays, credential
  requirements), `acuity` (tiers, ratios, HPPD), `rulesets`, `schedule`, `timeoff`, `calloffs`,
  `pay` (rates, differentials, overtime, budget), `ledger`, `incompatibility` (groups of nurses
  kept apart, migration 0011), shared `patch` (`patchOf`) and `bulk`
  (`insertRows`), `publish` (M12:
  `publishSchedule` writes a `schedule_version` + status + ledger; `requireChangeReason` /
  `recordScheduleChange` are the post-publish change log; M15: `solver` (the per-unit
  `solver_settings`) and `solve-input` (`loadPeriodInput`, the one definition of a period's
  `SolveInput`, shared by Generate, conflicts, cost and the solver benchmark)).
- `apps/desktop` (M3, complete): electron-vite. `src/shared/api.ts` is the IPC contract
  (`ShiftNurseApi`, `API_CHANNELS`); `src/main/` opens the DB in `userData` (migrations only;
  first-run setup decides what goes in it), implements the contract in `api.ts` (the wiring table) over the domain
  modules in `api/` (`context` holds the shared loaders and `scheduleViewFor`; `schedule` holds
  `editSchedule`), registers it in `ipc.ts`;
  `src/preload/` builds `window.shiftnurse` from the same channel table; `src/renderer/` is
  React 18 + TanStack Router (hash history, code-based routes) + TanStack Query + Tailwind v4
  tokens. Dashboard, Roster (CRUD, credentials, preferences, CSV import/export via native
  dialogs in main), Settings (shift types, coverage floors, acuity tiers/ratios/HPPD,
  holidays) and Demand (census grid, forecaster proposals, derived demand with binding
  constraint, back-test) and Schedule (M6: nurses × days grid, native HTML5 drag-and-drop,
  lock/charge/OT popover, live violation badges from `schedule.validate`, Settings > Rules
  versioned editor incl. fairness weights) and Fairness (M7: unit distribution, per-nurse
  breakdown with trend sparklines, history CSV import) and Cost (M8: Settings > Pay editor for
  rates/differentials/OT rules, budget-vs-actual + overtime concentration on the Dashboard, a
  running cost strip on the Schedule page) and Generate (M9: `main/solver-worker.ts` runs core's
  `solve` in a worker thread; `main/solver-jobs.ts` runs a *batch* of 1–10 variations (seeds
  `seedFor(period) + k`, parallelism and time estimate from `main/solver-plan.ts`) and keeps each
  finished report in memory as a candidate — nothing reaches the draft until `solver.save`;
  `main/api/solver.ts` previews a candidate through the grid's own `validateView`/`costReportForView`
  and compares every candidate with the draft via core's `scoreAssignments`; the renderer's
  `useCurrentBatch` in `api-solver.ts` drives `schedule/generate-dialog.tsx`,
  `candidates-bar.tsx` (page, preview, save) and `compare-dialog.tsx`)
  and Requests (M10: `core/conflicts` — `detectConflicts`, `generateResolutions`,
  `analyseConflicts`, `selectAutoResolutions`, `timeOffImpact` over the same `SolveInput` the
  solver uses; `db/repositories/conflicts.ts` holds the per-unit auto-resolve policy and
  `applyResolution`, which audits before it writes; the Requests page has the queue, entry
  dialog, overlap heatmap, decide-with-impact dialog and ranked resolution cards, and Settings >
  Conflicts holds the auto-resolve policy, off by default) and Exchanges (M11: Requests ›
  Exchanges — proposal dialog with live verdict, decide dialog; `exchange.approve` re-evaluates
  in main and requires an override reason on `warn`) and Publish (M12: `main/api/schedule.ts`
  `editSchedule` wraps every grid mutation and logs reasoned edits on a published period;
  `main/backups.ts` (publish/daily/manual/restore), `main/output.ts` + `print-html.ts` +
  `xlsx.ts` for PDF/CSV/xlsx; Schedule › Publish dialog, change log, Export menu, reason dialog
  on published-period edits; Settings › Backups) and Today (M13: `core/dayof/` — `findReplacements`
  ranks same-role nurses simulated on the conflicts engine, `checkStaffing`/`shiftsAround` for the
  live census re-check; `dayOf` IPC in `main/api/dayof.ts`, `backfill` goes through `editSchedule` as
  `'backfill'`; `pages/today.tsx` + `api-dayof.ts`) are real.
  Renderer hooks: `api.ts` (roster), `api-config.ts` (configuration + rules), `api-demand.ts`
  (census/demand), `api-schedule.ts` (grid mutations + validation), `api-fairness.ts`
  (report/trend/import), `api-cost.ts` (pay config, cost report, budget).
- Packaging (M14, complete): `apps/desktop/electron-builder.yml` + `scripts/{before-pack,dist}.mjs`
  produce mac dmgs (x64 + arm64) and a Windows NSIS installer. Both are verified: the mac build
  via `smoke:packaged`, the Windows installer by installing and launching it on native Windows
  (and by the packaged smoke on `windows-2022` in CI).
- **M16 — CI/CD** (complete; plan `docs/CI_PLAN.md`): `.github/workflows/ci.yml` (lint +
  typecheck on Linux; tests on ubuntu/macos-15/windows-2022) guards `main` through branch
  protection; `.github/workflows/release.yml` builds each installer natively on a `vX.Y.Z` tag,
  smoke-tests it, and creates a **draft** release (`.github/release-notes.md`); it dry-runs on PRs
  touching packaging. Builds are unsigned.
- **M15 — Selectable solvers** (complete; plan of record `docs/SOLVER_PLAN.md`, results
  `docs/solver-bench.md`): Settings › Solver picks **hybrid** (default), **SA + LNS** or **CP-SAT**
  per unit; the Generate dialog overrides per run. `native/cpsat-runner` is the C++ OR-Tools
  runner (JSON lines, `runner.proto`), built by `.github/workflows/cpsat-runner.yml` and released
  as `cpsat-runner-v*`; `apps/desktop/scripts/fetch-cpsat.mjs` pins tag + SHA-256 and fills
  `.cpsat/host` (postinstall) and `.cpsat/target` (before-pack). In main: `cpsat-process.ts`
  (runner client), `ortools-solvers.ts` (CP-SAT and hybrid orchestration, used by the worker and
  the benchmark), `solver-choice.ts` / `solver-backends.ts` (availability and fallback),
  `solver-bench.run.ts` (`npm run bench:solvers`).
- **First-run setup** (complete): an empty database opens on a welcome screen — demo, manual
  or assisted. `core/setup/` holds `state.ts` (`SETUP_STEPS`, `setupPhase`, the `SetupPreset`
  union), `presets.ts` (shift patterns, acuity presets by unit type, `coverageQuickFill`) and
  `holidays.ts` (`usFederalHolidays`); `db/repositories/setup.ts` persists the single-row
  `setup_state` (migration 0008) and applies presets through the ordinary audited creates;
  `main/api/setup.ts` is the `setup` IPC resource, and Start over is `resetDatabase` in
  `main/backups.ts`. Renderer: `setup/setup-gate.tsx` (in `RootLayout`), `welcome.tsx`,
  `assisted.tsx` + `assisted-steps.tsx` (each step embeds the real Settings editor), `steps.ts`;
  Settings › Unit (`pages/settings/unit.tsx`).

`README.md` is the build/run/ship guide for humans; `ARCHITECTURE.md` is the "why this stack"
write-up. Keep the three in step: a milestone or convention change here should be reflected
there when it affects setup, commands or the stack rationale.

## Architecture

```
packages/core/     # pure TS domain: rules, acuity, solver, fairness, cost, conflicts
packages/db/       # Drizzle + better-sqlite3 schema, migrations, repos
apps/desktop/      # Electron main / preload / renderer (see src/shared/api.ts first)
```

**The boundary rule is non-negotiable:** `packages/core` imports nothing from Electron and
nothing from the database. No `electron`, no `better-sqlite3`, no `drizzle-orm`, no `fs`, no
`node:*` I/O. Entities are plain data with no methods and no persistence concerns. That
purity is the entire reason the eventual web/mobile move is a re-host rather than a rewrite —
core becomes the server engine unchanged. If a core module needs data, it takes it as an
argument. If it needs to persist something, it returns a value and lets the caller persist it.

The same rule shapes the layers above: the DB is owned by the Electron main process only, the
renderer reaches it through a typed IPC surface deliberately shaped like the future HTTP API.

## The time model — the easiest thing here to break by accident

Read the header of `packages/core/src/domain/time.ts` before touching anything time-related.

Nurse contracts are written in **wall-clock time** ("at least 10 hours between shifts", "no
more than 4 consecutive 12-hour shifts"), not in absolute instants. Modelling shifts as UTC
timestamps would make one night shift 11 hours and another 13 across the twice-yearly DST
transitions, and every rest and consecutive-hours calculation would drift by an hour for one
day a year.

So the schedule lives on a **continuous local wall-clock timeline**: minute 0 is midnight
beginning 1970-01-01 local, and every day is exactly 1440 minutes. DST does not exist in this
coordinate system — which is precisely how the contract language treats it.

Rules that follow:

- **Duration comes from `durationHours`.** Never derive a shift's length by subtracting
  timestamps. The declared paid length is the truth.
- **Calendar maths goes through `Date.UTC`** (via `dayNumber` / `fromDayNumber` /
  `addDays`). Never construct a local-timezone `Date` for scheduling arithmetic. The one
  intentional exception is `today()`, which reads the host clock.
- **Shifts are dated by their START day.** A night shift dated Friday runs into Saturday
  morning and is still "Friday's night shift" — that is how units talk and how the grid prints.
- **Windows are half-open** `[startMinute, endMinute)`. A shift ending at 07:00 does not
  overlap one starting at 07:00.
- Real instants — audit timestamps, when a call-off was phoned in — use `Date`/epoch millis
  (`Timestamp`). Those are events, not schedule geometry. Do not mix the two.

`ScheduleView` carries a lookback tail of prior published assignments flagged
`inPeriod: false`: they participate in rest/consecutive/hours maths but never receive
violations of their own.

## Commands

| Command | What it does |
|---|---|
| `npm test` | `vitest run` over `packages/*/src/**/*.test.ts`, renderer tests and `apps/desktop/src/main/**/*.test.ts`. The real gate. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run test:coverage` | Tests with v8 coverage over `packages/*` and desktop `main`; CI's ubuntu leg posts a per-area table (`scripts/coverage-summary.mjs`) to the run summary. |
| `npm run lint` | `biome check .` — format + lint, no writes. |
| `npm run lint:fix` | Biome check with `--write`. |
| `npm run format` | `biome format --write .`. |
| `npm run typecheck` | Builds `core` and `db` first, then `tsc --build --force` against the root `tsconfig.json`, which covers every package **including test files**. The per-package configs set `composite` and exclude `*.test.ts` so they emit clean `.d.ts`, so a build-only check would never look at the tests. The build comes first because `db` and the desktop resolve `@shiftnurse/core` through its `dist` typings: without it a fresh checkout (CI) cannot typecheck, and a stale local `dist` would check against old types. |
| `npm run check` | lint + typecheck + test. The full gate CI runs (`FULL_CHECK=1` makes the pre-commit hook run it too). |
| `npm run build:packages` | Builds `core` then `db` with `tsc`. Required before `seed:demo`. |
| `npm run seed:demo` | Builds and runs the demo seeder into a local SQLite file. |
| `npm run seed:scenarios` | The same for the test-scenario database (`scenarios.sqlite`). |
| `npm run dev` | Builds packages, then runs package watchers + `electron-vite dev` with HMR. |
| `npm run build` / `dist` | Production bundles into `apps/desktop/out`; `dist` then packages with electron-builder. |
| `npm run smoke -w @shiftnurse/desktop` / `npm run smoke:packaged -w @shiftnurse/desktop` | Builds and boots the real app headlessly against a temp `userData`, asserts the preload bridge and dashboard rendered, exits non-zero otherwise. `--screenshot <png>` captures the window. Run this after touching main/preload/IPC — unit tests cannot see a wrong-ABI native module or a preload that never ran. With the CP-SAT runner installed it generates with every solver twice (minutes); `SHIFTNURSE_SMOKE_TIMEOUT_MS` raises the 240 s limit for an emulated x64 run. |
| `npm run bench:solvers` | Every solver × three units × three seeds → `docs/solver-bench.md`. Needs the runner; minutes; not part of `npm test`. `FALLBACK_ORDER` cites its result. |
| `npm run fetch:cpsat -w @shiftnurse/desktop` | Fetches the pinned CP-SAT runner for this machine into `apps/desktop/.cpsat/host`; fails loudly (postinstall only warns). |

## Git hooks (`.githooks/`, wired by `npm install` via the `prepare` script)

- **`pre-commit`** runs a fast mechanical gate — `biome check --staged`, an incremental
  typecheck, and `vitest related` for the staged files minus the real-runner CP-SAT test (~6 s;
  CI runs the full `npm run check` on three platforms) — then sends the staged diff to a
  headless Claude reviewer (`claude -p`, Sonnet, read-only tools) briefed on this repo's
  invariants. A `VERDICT: BLOCK` aborts the commit with the findings printed. Budget about a
  minute. `FULL_CHECK=1` runs the full `npm run check` instead; `SKIP_REVIEW=1` keeps the
  mechanical gate but skips the review; `--no-verify` skips both.
- **`prepare-commit-msg`** drafts a plain-English message from the staged diff for a bare
  `git commit`; it never touches a message given with `-m`/`-F`. To commit non-interactively
  with a drafted message: run `.githooks/prepare-commit-msg <file> ""` then `git commit -F <file>`.
- The review fails *open* (no verdict → not blocked) so a flaky reviewer cannot wedge the
  repo; the mechanical gate fails closed.

## Conventions

- **npm workspaces, not pnpm.** pnpm is not installed on this machine, and npm is the safer
  pairing with Electron native modules. Do not introduce a pnpm lockfile or workspace file.
- **`.js` extensions on relative TS imports** — `from './time.js'`. ESM output, non-negotiable.
- **`noUncheckedIndexedAccess` is on**, so `arr[0]` is `T | undefined`. Where the index is
  provably safe, `arr[0]!` is idiomatic. Biome's `style/noNonNullAssertion` is deliberately
  disabled: its suggested `?.` "fix" silently changes semantics from "this cannot be
  undefined" to "skip if it is", which turns a scheduling bug into a silently wrong number.
- **Biome for both format and lint.** Single quotes, trailing commas, semicolons, 100 cols,
  2-space indent. `noExplicitAny`, `noUnusedVariables`, `noUnusedImports` are errors.
- **Comments explain WHY, not WHAT.** Every module header in core states why it exists and
  what would go wrong without it. Match that.
- **Tests are named for the real-world scenario, not the function**: `'flags the night-to-day
  turnaround'`, `'exempts per-diem nurses from the under-hours check'`. A test name should
  read like something a nurse manager would say.
- Rules are data plus a small evaluator in `rules/registry.ts`. A new contract clause is a new
  `Rule` plus a registry entry — the solver, grid and compliance report pick it up for free.
- **Repository functions take `DbLike` first**, never `ShiftNurseDb`. That is what lets any of
  them run standalone or compose inside one `transact()` — publishing a schedule writes
  assignments, a period status, a fairness ledger and audit entries, and a partial publish is
  worse than a failed one.
  The exception proves the rule: a function whose several writes are only correct together —
  `moveAssignment`, `approveSwap`, `importRoster`, `importHistoricalLedger`,
  `approveTimeOffAndLiftAssignments`, `applyResolution` — takes `ShiftNurseTx`, so calling it
  outside a transaction is a type error rather than a docstring nobody read.
- **Every mutation writes an audit entry in the same call**, with `before` on updates/deletes.
  Denials, resolutions and overrides go through `recordAuditStrict`, which refuses to record
  without a stated reason — that text is what gets quoted if a decision is challenged.
- **Rule set versions are immutable.** `saveRuleSet` always inserts a new version; a published
  period snapshots the version it was solved under, so editing rules must never rewrite the
  rules an existing schedule was judged by.
- **`better-sqlite3` is synchronous.** No `async`/`await`/`Promise` in `packages/db`.
- **One better-sqlite3, for Node and Electron alike.** Since 13 it is a Node-API module: the
  package ships one prebuilt binary per platform (`prebuilds/<os>-<arch>.node`) that loads under
  the system Node (tests, seeder) and Electron's embedded Node unchanged, with no install-time
  download. `apps/desktop` depends on it directly and electron-vite leaves it external, so the
  bundled `@shiftnurse/db` and `drizzle-orm` load it from disk. (12.x needed a second, Electron-ABI
  copy behind an npm alias and a postinstall swap, and published no build for Electron 44's ABI.)
  An Electron bump no longer waits on a better-sqlite3 prebuild.
- **Packaging never rebuilds native modules.** `npmRebuild: false`: the prebuilds are already
  right for every target, and a rebuild would only compile for the build machine.
  `electron-builder.yml` ships only the target OS's better-sqlite3 prebuilds (`mac.files`,
  `win.files`), and `scripts/before-pack.mjs` fetches the CP-SAT runner for each *target*
  platform/arch (a Windows installer built on a Mac must not carry a darwin binary).
  Electron is pinned to an exact version (electron-builder refuses a range). Everything
  electron-vite bundles (`@shiftnurse/*`, react, radix, tanstack) is a **devDependency**;
  `dependencies` is exactly the set the packaged main process loads from disk. `npm run
  smoke:packaged` boots the built `.app`/`.exe` from `release/` in smoke mode — run it after any
  packaging change; the dev-binary smoke cannot see a missing migration or wrong-ABI binary.
- **The renderer never re-derives time maths.** `renderer/src/format.ts` splits ISO strings
  for display and calls core's `weekdayOf`/`dayNumber` for anything else. The first version
  computed weekday as `dayNumber % 7` and labelled Sunday 2026-09-20 "Wed" — day 0 of the
  epoch was a Thursday. Renderer unit tests live next to the code and run under `npm test`.
- **`ELECTRON_RUN_AS_NODE` must be unset when launching Electron.** VS Code's integrated
  terminal exports it, and with it set the Electron binary is a bare Node runtime — the
  symptom is `'electron' does not provide an export named 'BrowserWindow'`. `scripts/smoke.mjs`
  strips it; for `npm run dev` in a VS Code terminal, `unset ELECTRON_RUN_AS_NODE` first.
- **The preload is CommonJS** (`out/preload/index.cjs`) because a sandboxed preload has no ESM
  loader. Everything else in the app is ESM.
- **`schedule.validate` judges a period by its own `ruleSetId` snapshot, never "latest".**
  A full pass over a 6-week, 42-nurse draft takes ~14ms in main, so the grid re-validates
  after every mutation via query invalidation rather than predicting violations client-side.
- **Repository patches go through `patchOf` with a `PatchKeys<Patch>` allow-list**
  (`db/src/repositories/patch.ts`). IPC payloads are typed, not checked, so spreading a patch
  into a row once let `{ unitId }` move a nurse between units and `{ date }` move a locked
  shift. An unknown key throws. An assignment's date, shift and nurse change only by a move;
  `AssignmentPatch` carries flags and notes, and IPC creates are always `source: 'manual'`.
- **Only the app's own page may navigate or call IPC.** `main/trusted-origin.ts` is the
  policy: `will-navigate` is blocked for any other URL (a file dropped on the grid would
  otherwise load with the preload bridge), `ipc.ts` refuses untrusted sender frames, and
  `openExternal` takes only `https:`/`mailto:`.
- **Moving a shift is delete + create in one `transact`.** `nurseId` is immutable on an
  assignment; the move carries `isCharge`/`isOvertime`/`notes` across and refuses locked rows.
- **The smoke test creates data through the raw bridge**, which bypasses the renderer's
  mutation hooks and their invalidation; it reloads the window before asserting on the grid.
  Do not read that as a cache bug in the app.
- **Adding an IPC method:** add it to `ShiftNurseApi` and `API_CHANNELS` in `shared/api.ts`,
  implement it in `main/api.ts` (logic in the matching `main/api/` module). Preload and renderer types follow; a missing implementation
  is a type error, not a runtime "no handler".
- Bad data throws loudly (`ScheduleView` throws on an unknown nurse id). Silently dropping a
  row hides corruption; in scheduling that becomes a grievance.
- **Fairness fair-share is pinned to `contractedHoursPerPeriod`, never worked hours.** That is
  what makes the score monotone (an extra night can never raise it); basing shares on hours
  actually worked would let a nurse who works only nights "improve" by taking one more. Only
  a shift that honours none of a nurse's preferences is unambiguously worse — a day shift for
  a nurse avoiding nights raises their hit rate — so the property test excludes such pairs.
- **`call_off` carries the shift (period/nurse/shift type/date) and no FK on `assignmentId`.** A
  backfill deletes the absent nurse's row and writes a `source: 'callout'` one, so the call-off and
  its call log must outlive the id they point at — the same reason `shift_swap` has no assignment
  FK. Migration 0005 rebuilds `call_attempt` before dropping `call_off`: the drizzle migrator runs a
  file inside one transaction, where `PRAGMA foreign_keys=OFF` is a no-op and a parent drop
  cascades into its children.
- **The ledger's `periodId` has no foreign key on purpose:** imported history uses synthetic
  `import:<start>` ids for pay periods that predate the app.
- **Every rule declares a `scope`** (`'nurse'` or `'shift'`). The solver evaluates hard rules
  incrementally on a view holding one nurse's timeline or one shift's roster, so a rule that
  secretly reads more than its scope passes in the solver and fails on the grid. Nurse-scope hard
  rules gate every addition (except `under_contracted_hours`, a floor the objective pushes toward);
  shift-scope hard rules are priced, and what remains is the report's `unfilled` list.
- **The solver is deterministic by construction.** All randomness comes from `Rng` seeded from
  a hash of the period id; the iteration budget, not the clock, ends the run (the wall-clock limit
  is a safety valve). Anything that depends on wall time in a solve path breaks "regenerate
  unchanged inputs → identical schedule", which the smoke test asserts. A batch's variation k is
  seeded `seedFor(period) + k`, so variation 1 is the schedule a single Generate always gave and
  the same inputs give the same variations whatever ran in parallel. "Generate more" passes
  `continueAfter`, carrying numbering and seeds on (a second batch of three is variations 4–6 —
  `SolveBatchStatus.offset`), so it searches seeds not yet tried; unticking it starts over at 1.
  The offset lives in memory with the batch, so a restart begins again at variation 1. The grid's
  own schedule is scored beside every batch (`draftObjective`) and counts as a contender: when no
  variation beats it, the app says keep it.
- **Generate candidates go stale by fingerprint, not by event.** `inputFingerprint`
  (`main/solver-plan.ts`) hashes the whole `SolveInput` minus the unlocked draft rows the solver
  discards; `solver.current`/`candidate`/`save` re-check it, so any change to anything the solver
  reads — a table added later included — drops the candidates and `save` refuses them. OR-Tools
  variations run `floor(cores / SEARCH_WORKERS)` at a time: oversubscribing the runner's threads
  only stretches wall time into the hybrid's fallback, which is a different schedule.
- **Every registered rule needs a CP-SAT encoding.** `CPSAT_ENCODERS` in `solver/cpsat/encode.ts`
  maps each rule id to an encoder or `'by-construction'`; a test fails on any missing id, and
  `encodeCpsat` refuses by name when an enabled hard rule has none. A new rule is therefore a
  `Rule`, a registry entry *and* an encoder, checked against the rule engine by
  `encode.test.ts` (hand-worked cases, parity with `SolverModel`, and 400 random rosters that
  must be judged identically). CP-SAT's answers still go back through `SolverModel.canAdd`
  before anything is written — the rule engine stays the judge.
- **The OR-Tools runner lives in the solver worker, never in core or on the main thread.**
  Core holds the pure halves (`prepareCpsat`/`finishCpsat`, `LocalSearch.encodeWindow`/
  `applyWindow`); `main/ortools-solvers.ts` does the async step between. CP-SAT is deterministic
  only as configured in `cpsat/params.ts`: 8 workers with `interleave_search`, a seed from the
  period, a deterministic-time budget — its parallel portfolio is faster but not reproducible.
  A runner that is missing, crashes or times out makes the hybrid finish as SA + LNS with
  `fellBackFrom` set; that is a *different schedule*, which is why the ready timeout is generous.
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
- **The packaged smoke test runs outside the repo and needs `[smoke] PASS`.** `scripts/smoke.mjs`
  copies the packaged app to a temp dir first and fails unless the app prints the marker. Inside
  the repo a module missing from the app is found in the repo's `node_modules`, and a startup
  crash dialog exits 0 when dismissed; v0.1.0's first draft crashed on every real install that
  way. Anything the packaged main process imports at runtime must be bundled (so the
  `better-sqlite3` alias applies — `drizzle-orm` is, for exactly that reason) or be a real
  `dependency`. `SHIFTNURSE_SMOKE_SOLVE_TIMEOUT_MS` / `SHIFTNURSE_SMOKE_TIMEOUT_MS` loosen its
  limits for slow CI runners.
- **The solver gates removals too.** `SolverModel.isLegal` re-checks a nurse who lost a shift:
  the consecutive-nights rule counts only all-night stretches, so removing a day from "day + four
  nights" creates a violation. Any new move that takes a shift from a nurse must re-check them.
- **Credit and licences travel with the code that needs them.** OR-Tools/CP-SAT and every library
  the runner bundles are listed in `native/cpsat-runner/THIRD_PARTY_NOTICES.md`, with full texts
  in `native/cpsat-runner/licenses/` that the CMake install copies into every bundle; research a
  solver technique comes from is cited in its module header and in README › Credits and
  references. Bundling a new library or adopting a published method means adding its entry.
- **`dayNumber`/`fromDayNumber` are memoised.** The rule engine on partial views converts the same
  few dozen dates millions of times per solve; without the cache that was 60% of a run.
  `compareDates`, `minDate`, `maxDate` and `dateInRange` compare the ISO strings directly
  (validated `YYYY-MM-DD` sorts in calendar order): `compareDates` returns only a sign — use
  `daysBetween` for a distance. `ScheduleView.dates` is a shared, frozen array; its other indexes
  are built on first use.
- **Solver speed-ups must not change a schedule.** `SolverModel` caches fairness (cleared in
  `count`), staffing per shift and role, prepared rules (`prepareRules`/`evaluatePrepared`) and
  per-nurse rule contexts. `solver/model.test.ts` checks every cached term against a fresh
  rebuild after a random walk of moves and undos. Array order is behaviour (`pickUnlocked` samples
  by index, `ensureCharge` takes the first eligible nurse on the roster), so no swap-removes.
  Check a performance change by hashing SA + LNS output on fixed inputs before and after.
- **Two kinds of seeded data, for two audiences.** The realistic demos an evaluator explores
  are `DemoProfile`s (`seed/demo/profiles.ts`: community med-surg, VA San Francisco med-surg,
  California ICU) run through one engine (`seed/demo/engine.ts`); `seed/demo.ts` holds
  `seedDemoUnit(db, { demo })` and the `DEMO_SUMMARIES` the welcome screen lists through
  `setup.demos`. Each profile's numbers come from real practice for that setting, stated in its
  comment, and nothing is planted. A new demo is a profile, a summary and a test file in
  `seed/demo/` that runs `realisticDemoChecks` (`checks.test-support.ts`, excluded from the
  package build) plus the facts particular to that unit. `seed/scenarios.ts` (`seedScenarioUnit`) is the
  test-scenario database with known, asserted problems; the main-process fixture, repository
  tests and the solver benchmark are built on it, and `npm run dev` offers it on the welcome
  screen. **Tests never use the demo as a fixture** — its data should be free to become more
  realistic — and **the scenario data must not change**: test expectations are pinned to it
  (even an extra inactive nurse changes a generated schedule, since the solver sees every nurse
  in roster order). A new scenario is appended from its own `Rng` together with re-pinned tests
  and a re-run `npm run bench:solvers`. The benchmark's scenario row is *not* reproducible run
  to run — ids are random UUIDs, so each seeding solves differently (three seedings gave
  objectives of 76,760–79,497) — so compare its medians and rankings, not exact numbers; the
  fixture-only rows (synthetic-24, small-8) are exact.
- **Demo data must be staffable by construction.** Each demo's contracted hours are sized to
  its floors, the history is staffed by the engine's `canWork`, which mirrors the unit's own rule
  set (rest from shift windows, stretch and all-night limits, days off after a maximum stretch,
  leave by shift date, hire dates), and `canRemove` checks every shift it moves away or calls
  off, and to the *forecast* census the rule engine judges by. Every demo's test runs Generate
  on its draft at the app's default budget and requires every floor filled, and requires fewer
  than 5% of nurse-pay-periods to read "under contract" (paid leave and sick calls are credited).
  A nurse at contract who picks up a call-off still reads "over contract": the rule counts any
  hours past it. The contracted hours are 72h a pay period for full-time 12-hour
  staff (three 12s under a 40h overtime threshold). Changing floors, census or the roster mix
  means re-running the demo tests in `seed/demo/`. The VA demo is a compressed biweekly
  schedule: full-time rows carry a `shortShift` (one D8 a pay period on top of six 12s, 80h),
  which the engine holds hours back for and places in a pass of its own, and its rule set judges
  overtime by pay period. The D8 runs inside the day 12 (`within: 'D12'`), which covers it, and
  the engine lets a new grad onto it only with an experienced RN on the D8 or that day's D12.
  The engine counts hours, not shifts, which for the all-12-hour demos is the same arithmetic
  scaled: their seeded data did not change. A profile's `keptApart` groups (the VA demo has an
  RN pair, a trio of nursing assistants, and five LVNs at most two at a time) are created before
  the history, and `canWork`
  refuses any shift that would put a member on the floor with another once their group applies.
  Members are drawn one per role/position slot, never a charge nurse or new grad, and spread
  across days, nights and the intermittent pool: two full-timers each working seven day tours a
  pay period cannot be separated by splitting fourteen days, and a real ward separates people by
  tour; a group of five is staffable only with a cap above one. The RNG draws for them happen only when a profile has groups, so the other demos'
  data did not change.
- **Cover is by the hour, as units judge it.** A shift type may run inside another
  (`withinShiftTypeId`; `schedule/cover.ts` is the one definition of which dated shift covers
  which, a night included). The inside shift has no charge nurse of its own, and the containing
  shift's roster counts toward its credential requirements and toward the experienced RNs a new
  grad on it needs. The coverage rule is still `'shift'` scope, but its view of an inside shift
  must hold the containing shift's roster: `SolverModel.coveragePenalty`, the conflicts engine's
  `shiftViolations` and CP-SAT's `coverExpr` all add it, a change to a containing shift
  re-prices the shifts inside it (`innerShifts`, and `shiftViolationsAround` for simulated
  changes), and CP-SAT treats a shift as movable when its cover is. Only experienced **RNs**
  cover a new grad: an LVN or nursing assistant cannot supervise an RN. The repository refuses
  a containing shift whose hours do not hold the inside one, or a chain.
- **Main never seeds the demo on its own.** `openAppDatabase` only migrates; the demo is loaded
  by the welcome screen through `setup.loadDemo` (the test scenarios through
  `setup.loadScenarios`, which main allows only under the electron-vite dev server), and all of
  them and `setup.createUnit` refuse once any unit exists. `setupPhase` treats units-but-no-`setup_state`-row as `ready`, so an install
  from before first-run setup never sees the welcome screen. Presets are idempotent — they only
  add what is missing (coverage quick-fill sets the floors it names) — so pressing one twice, or
  revisiting a step, never duplicates rows. The smoke run starts empty and clicks "Explore the
  demo" before any other check, then walks the guide once on the demo unit.
- **A published period is editable, with a reason.** Only `archived` is read-only. Every
  schedule mutation takes an optional `reason`; `requireChangeReason` throws on a published
  period without one and `editSchedule` in main writes each touched shift to `schedule_change`.
  A republish needs a reason and refuses an unchanged schedule. The diff is keyed on
  nurse/date/shift, never row ids, so a regenerate that lands the same shifts is "no change".
- **Incompatible staff are judged by the hours they share.** An `IncompatibilityGroup` (two or
  more nurses, a `maxTogether` cap, optional `startsOn`/`endsOn` applied by shift date) feeds two
  shift-scope rules in `rules/incompatibility-rules.ts`: `incompatible-staff-cap` (soft) and
  `incompatible-staff-buffer` (hard: while two or more members overlap, `minOutsideStaff` people
  from outside the group on the floor). `schedule/overlap.ts` is the one definition of "on the
  floor together" (half-open windows, on-call excluded) and `judgeFloor` the one verdict; the
  rules, `SolverModel` (per-stretch cache, `stretchesOf`), CP-SAT (`incompatibilityTerms`, priced
  at either severity, hence `'by-construction'` in `CPSAT_ENCODERS`) and the conflicts engine
  (overlapping rosters, only when the input has groups) all use them. Both are priced per
  person-hour — `incompatibility` when soft, `hardShortfall / 12` when hard — which makes any
  cutting of the floor into stretches price the same; they are kept out of `shiftHardIds`
  because one shift's roster cannot judge them. The group's reason is HR-sensitive: audited
  (`recordAuditStrict`, always required) and shown on Roster › Kept apart, never in a violation
  message, which reaches the grid, exports and grievances.
- **Leave belongs to the shifts dated in it.** A shift is dated by its start day, so leave on
  the 7th removes the shift that starts on the 7th — a night running into the 8th included — and
  leaves the night of the 6th (ending on the 7th's morning) free to work. The time-off rule's
  `nightShiftEndingOnLeaveCounts` (off by default) is for contracts that make a day off a whole
  calendar day; it is judged by the shift's window (`crossesMidnight`), never by `isNight`, which
  also flags a Title 38 evening tour that ends before midnight. `overlappingLeaveDate` is the one
  definition, shared by the rule and the CP-SAT encoder.
- **Paid leave counts toward the contract, not toward overtime.** Approved leave carries
  `paidHours` (the shifts it pays, not every calendar day; the request dialog suggests them with
  `suggestedPaidLeaveHours`), and a call-off can be paid from sick leave (`paidSickHours`,
  credited only once the shift is off the schedule, so an uncovered call-off is not counted
  twice). `rules/paid-leave.ts` turns both into per-day credits in `RuleContext.paidLeaveByNurse`;
  the contracted-hours rule adds them (`paidLeaveCountsTowardHours`, on), the max-hours rule adds
  them to the overtime threshold only when `paidLeaveCountsTowardOvertime` is on (off: federal
  wage-and-hour law does not treat leave as hours worked) and never to the absolute weekly cap.
  Every consumer reads the same credit: `SolverModel` takes it off `hoursTarget` and adds it to
  `weekLeaveHours`, the CP-SAT caps subtract it (rounded down to integer hundredths), the cost
  engine starts a week's overtime count with it via `CostContext.overtimeLeaveHours`, and
  compliance alerts count it. `SolveInput.paidSickCalls` comes from `loadPeriodInput`.
- **`contractedHoursPerPeriod` is per pay period, not per schedule period.** A six-week
  period is three pay periods; anything comparing scheduled hours to the contract must scale by
  `periodDays / unit.payPeriodDays` (compliance alerts do; the under-hours rule works per pay
  period already).
- **Backups use SQLite's online backup API**, never a file copy — a WAL database copied by
  hand loses un-checkpointed pages. The smoke run builds core/db from `dist`, so rebuild packages
  (`npm run build:packages`) after touching core before trusting a smoke result.
- **Costing is never a silent zero.** A nurse with no resolvable pay rate makes their shifts
  *unpriced* (`rateSource: 'none'`, counted in `unpricedAssignments`) and every cost surface
  shows that count next to the total. Overtime is priced per nurse-week over the full timeline
  including the lookback tail, using the work-week start from the `max-hours-per-week` rule
  params, so a shift can never be flagged as overtime by the rules and priced as straight time.
  A `pay_period` overtime rule (8/80-style) prices per nurse-pay-period instead; the max-hours
  rule's `overtimeByPayPeriod` is its rule-engine twin, honoured by `SolverModel.eligible`, the
  CP-SAT encoder, compliance alerts and the exchange evaluator alike. The weekly cap
  (`maxHoursPerWeek`) binds every week either way. The DB's `effectiveRateForNurse` delegates to core's `resolvePayRate`; do not add a second
  definition of "the rate in force".

## Development discipline

- **Test-first in `packages/core`.** Write the failing test, watch it fail, then make it
  pass. This is scoped to domain logic — rules, solver, fairness, acuity, cost — not to UI
  scaffolding, Electron wiring, config, or throwaway spikes. It matters here specifically
  because scheduling bugs are silent: a rule that never fires, a fairness score that's
  subtly wrong, an off-by-one in a rest calculation — none of these crash. They produce a
  schedule that *looks* plausible and is wrong, and it surfaces weeks later as an
  understaffed shift or a grievance. Watching the test fail first is the only evidence it
  actually checks the thing you think it checks; a test that passes on the first run might
  be checking nothing.
- **No tautological tests.** An assertion must not recompute the expected value the same
  way the implementation does — if the test does `start - end` and the code does `start -
  end`, a shared bug survives both. Expected values come from an independent source: hand
  computation or a known real-world case. E.g. a rest-period test should assert `0` hours
  between a 19:00–07:00 night shift and the following 07:00 day shift — a fact you compute
  by hand — not re-derive the subtraction the rule itself performs.
- **Root cause before fix.** A change that makes a symptom disappear without an explanation
  of the mechanism is not a fix. In scheduling code this usually looks like special-casing
  one date or one nurse — which hides a general defect in the time model or rule engine and
  will resurface on the next period. If you can't explain why the bug happened, the work
  isn't done.
- **Evidence before claims.** Don't report something as passing without having run it.
  `npm run check` (lint + typecheck + test) is the gate — state outcomes as what it actually
  printed, not what you expect it to print.

## Domain glossary

- **FTE** — full-time equivalent; 1.0 = full time. Drives `contractedHoursPerPeriod`.
- **Acuity tier** — how sick a patient is. Higher tier = more nursing care hours per day.
- **HPPD** — nursing hours per patient day. A *soft* budget target, never a hard constraint.
- **Patient ratio** — a hard ceiling on patients per nurse (e.g. 1:5 med-surg). Legal or
  contractual; breaching one makes a schedule infeasible.
- **Coverage floor** — static minimum staffing per shift/weekday, independent of census.
  Demand is `max(floor, ratio-derived)`: acuity can only push staffing up, never below.
- **Charge nurse** — the RN running the shift. Every standalone shift requires exactly one; a
  shift that runs inside another (a mid or short shift, like the VA demo's 8) works under that
  shift's charge nurse and has none of its own.
- **Novice** — new grad / recent hire. A novice must work with at least one experienced RN on
  the unit during the shift — on it, or on the shift it runs inside; any other role does not count.
- **Per-diem** — as-needed staff with no contracted-hours floor, so exempt from under-hours checks.
- **Hard vs soft rule** — hard = illegal, the solver will never emit one. Soft = advisory, the
  manager can knowingly accept it. Fairness pressure lives in the objective function, not here.
- **Fairness ledger** — per nurse per period: nights, weekends, holidays, on-call, denied
  requests, OT. The rolling burden history that fairness scoring balances against.

## Pointers

- **`ROADMAP.md` is the plan of record** — 16 milestones and a proposed M17, locked-in decisions, verification
  steps. Tick a box when the work lands *and* its verification passes, not when code is written.
- **`.claude/skills/scheduling-review`** — the domain review checklist for scheduling changes.
- `.claude/scripts/` — SessionStart roadmap summary and a non-blocking Stop-hook test run.
