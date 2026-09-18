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
  index, mix validation, back-test), `testing/fixtures.ts`.
- `packages/db` (M2, complete): 26-table Drizzle schema, generated migrations, `client.ts`
  (WAL, foreign keys ON, `transact`), `audit.ts`, `mappers.ts`, and repositories under
  `repositories/` — `roster`, `config`, `schedule`, `timeoff`, `operations`.
- `apps/desktop` (M3, complete): electron-vite. `src/shared/api.ts` is the IPC contract
  (`ShiftNurseApi`, `API_CHANNELS`); `src/main/` opens the DB in `userData` (seeding the demo
  unit on first launch), implements the contract in `api.ts`, registers it in `ipc.ts`;
  `src/preload/` builds `window.shiftnurse` from the same channel table; `src/renderer/` is
  React 18 + TanStack Router (hash history, code-based routes) + TanStack Query + Tailwind v4
  tokens. Dashboard, Roster (CRUD, credentials, preferences, CSV import/export via native
  dialogs in main), Settings (shift types, coverage floors, acuity tiers/ratios/HPPD,
  holidays) and Demand (census grid, forecaster proposals, derived demand with binding
  constraint, back-test) are real (M3–M5); Schedule and Requests are placeholders until
  M6/M10. Renderer hooks: `api.ts` (roster), `api-config.ts` (configuration),
  `api-demand.ts` (census/demand).

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
| `npm test` | `vitest run` over `packages/*/src/**/*.test.ts`. The real gate. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run lint` | `biome check .` — format + lint, no writes. |
| `npm run lint:fix` | Biome check with `--write`. |
| `npm run format` | `biome format --write .`. |
| `npm run typecheck` | `tsc --build --force` against the root `tsconfig.json`, which covers every package **including test files**. The per-package configs set `composite` and exclude `*.test.ts` so they emit clean `.d.ts`, so a build-only check would never look at the tests. |
| `npm run check` | lint + typecheck + test. The pre-commit gate. |
| `npm run build:packages` | Builds `core` then `db` with `tsc`. Required before `seed:demo`. |
| `npm run seed:demo` | Builds and runs the demo seeder into a local SQLite file. |
| `npm run dev` | Builds packages, then runs package watchers + `electron-vite dev` with HMR. |
| `npm run build` / `dist` | Production bundles into `apps/desktop/out`; `dist` then packages with electron-builder. |
| `npm run smoke -w @shiftnurse/desktop` | Builds and boots the real app headlessly against a temp `userData`, asserts the preload bridge and dashboard rendered, exits non-zero otherwise. `--screenshot <png>` captures the window. Run this after touching main/preload/IPC — unit tests cannot see a wrong-ABI native module or a preload that never ran. |

## Git hooks (`.githooks/`, wired by `npm install` via the `prepare` script)

- **`pre-commit`** runs `npm run check`, then sends the staged diff to a headless Claude
  reviewer (`claude -p`, Sonnet, read-only tools) briefed on this repo's invariants. A
  `VERDICT: BLOCK` aborts the commit with the findings printed. Budget about 1½ minutes.
  `SKIP_REVIEW=1` keeps the test gate but skips the review; `--no-verify` skips both.
- **`prepare-commit-msg`** drafts a plain-English message from the staged diff for a bare
  `git commit`; it never touches a message given with `-m`/`-F`. To commit non-interactively
  with a drafted message: run `.githooks/prepare-commit-msg <file> ""` then `git commit -F <file>`.
- The review fails *open* (no verdict → not blocked) so a flaky reviewer cannot wedge the
  repo; the test gate fails closed.

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
- **Every mutation writes an audit entry in the same call**, with `before` on updates/deletes.
  Denials, resolutions and overrides go through `recordAuditStrict`, which refuses to record
  without a stated reason — that text is what gets quoted if a decision is challenged.
- **Rule set versions are immutable.** `saveRuleSet` always inserts a new version; a published
  period snapshots the version it was solved under, so editing rules must never rewrite the
  rules an existing schedule was judged by.
- **`better-sqlite3` is synchronous.** No `async`/`await`/`Promise` in `packages/db`.
- **Two copies of better-sqlite3, on purpose.** The hoisted `better-sqlite3` is built for the
  system Node (tests, seeder). `apps/desktop` depends on `better-sqlite3-electron`, an npm
  alias of the same package whose binary `scripts/rebuild-sqlite-for-electron.mjs` swaps for
  the Electron-ABI prebuild on postinstall. The main bundle inlines `@shiftnurse/db` and
  aliases the import (see `electron.vite.config.ts`), so `db` itself knows nothing about it.
  Bumping Electron means checking that better-sqlite3 publishes a prebuild for its ABI.
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
- **Adding an IPC method:** add it to `ShiftNurseApi` and `API_CHANNELS` in `shared/api.ts`,
  implement it in `main/api.ts`. Preload and renderer types follow; a missing implementation
  is a type error, not a runtime "no handler".
- Bad data throws loudly (`ScheduleView` throws on an unknown nurse id). Silently dropping a
  row hides corruption; in scheduling that becomes a grievance.

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
- **Charge nurse** — the RN running the shift. Some shifts require exactly one.
- **Novice** — new grad / recent hire. A shift staffed entirely by novices is a violation.
- **Per-diem** — as-needed staff with no contracted-hours floor, so exempt from under-hours checks.
- **Hard vs soft rule** — hard = illegal, the solver will never emit one. Soft = advisory, the
  manager can knowingly accept it. Fairness pressure lives in the objective function, not here.
- **Fairness ledger** — per nurse per period: nights, weekends, holidays, on-call, denied
  requests, OT. The rolling burden history that fairness scoring balances against.

## Pointers

- **`ROADMAP.md` is the plan of record** — 14 milestones, locked-in decisions, verification
  steps. Tick a box when the work lands *and* its verification passes, not when code is written.
- **`.claude/skills/scheduling-review`** — the domain review checklist for scheduling changes.
- `.claude/scripts/` — SessionStart roadmap summary and a non-blocking Stop-hook test run.
