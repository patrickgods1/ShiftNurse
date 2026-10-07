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

## Where things are

Every milestone through M16 is complete and green. **M18 — Release hardening** is in progress
(boxes in `ROADMAP.md`): the 2026-10-03 release audit's fixes, one PR per phase — data safety,
renderer correctness, the manager's experience, core maintainability, tests, contract rules for
1.0, unsigned distribution. M17 (signing) is deferred; M19–M26 are the union and HR features
planned for after 1.0. M27–M37 (law, contracts, the VA demo and the 2026-10-06 audit's fixes) are
complete and M38 (the VA's 72/80 and Baylor schedules) is open.

Detail lives next to the code, in CLAUDE.md files that load when you work in that folder:

| Folder | Holds |
|---|---|
| `packages/core/` | pure domain: `domain/time.ts`, `domain/entities.ts`, `rules/`, `acuity/`, `fairness/`, `conflicts/`, `exchange/`, `publish/`, `dayof/`, `leave/`, `setup/`, `testing/fixtures.ts`. Its CLAUDE.md has the module map and every domain rule (leave, holidays, ratios, cover…). |
| `packages/core/src/solver/` | SA + LNS, hybrid, CP-SAT encoding; determinism and speed-up rules |
| `packages/core/src/cost/` | pay model, overtime, unpriced shifts |
| `packages/db/` | Drizzle schema, migrations, repositories (`DbLike`/`ShiftNurseTx`), `solve-input.ts` |
| `packages/db/src/seed/` | demo profiles vs. the frozen test scenarios |
| `apps/desktop/` | Electron main/preload/renderer; `src/shared/api.ts` is the IPC contract — read it first. Packaging, smoke, backups, IPC conventions. |
| `.github/`, `.githooks/` | CI/release workflows; pre-commit gate and AI reviewer |

`README.md` is the build/run/ship guide for humans; `ARCHITECTURE.md` is the "why this stack"
write-up. Keep them and these CLAUDE.md files in step: a milestone or convention change here should be reflected
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
| `npm test` | Vitest over packages, renderer and desktop `main`. The real gate. |
| `npm run test:watch` / `test:coverage` | Watch mode / v8 coverage (see `.github/CLAUDE.md`). |
| `npm run lint` / `lint:fix` / `format` | Biome check / with `--write` / format only. |
| `npm run typecheck` | Builds `core` + `db` (their `dist` typings are what `db` and desktop resolve), then `tsc --build --force` on the root config, which is the only one that includes test files. |
| `npm run check` | lint + typecheck + test — the gate CI runs. |
| `npm run build:packages` | Builds `core` then `db`. Required before `seed:demo` and before trusting a smoke run after a core change. |
| `npm run seed:demo` / `seed:scenarios` | Seeds the demo / test-scenario SQLite file. |
| `npm run dev` | Package watchers + `electron-vite dev`. In a VS Code terminal `unset ELECTRON_RUN_AS_NODE` first. |
| `npm run build` / `dist` | Production bundles / electron-builder packages. |
| `npm run smoke[:packaged] -w @shiftnurse/desktop` | Boots the real app headlessly; run after touching main/preload/IPC (see `apps/desktop/CLAUDE.md`). |
| `npm run bench:solvers` | Solver benchmark → `docs/solver-bench.md`; minutes, needs the runner. |

Git hooks (`.githooks/`, wired by `npm install`): `pre-commit` runs a fast mechanical gate then a
headless Claude review (`FULL_CHECK=1`, `SKIP_REVIEW=1`, `--no-verify`); `prepare-commit-msg` drafts
a message for a bare `git commit`. Details in `.githooks/CLAUDE.md`.

## Conventions (cross-cutting)

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
- **Repository functions take `DbLike` first**, never `ShiftNurseDb`. That is what lets any of
  them run standalone or compose inside one `transact()` — publishing a schedule writes
  assignments, a period status, a fairness ledger and audit entries, and a partial publish is
  worse than a failed one.
  The exception proves the rule: a function whose several writes are only correct together —
  `moveAssignment`, `approveSwap`, `importRoster`, `importHistoricalLedger`,
  `approveTimeOffAndLiftAssignments`, `applyResolution`, `saveRuleSet` (a header, its configs and
  the audit row — a header alone would be a "latest" rule set with no rules), and the holiday
  writes (`updateHoliday`, `deleteHoliday`, `recordHolidayWork`, `clearHolidayWork`,
  `addHolidayYear`), `applyJurisdiction` and `awardRound` (a bid round's awards, approvals,
  denials and status) — takes `ShiftNurseTx`, so calling it
  outside a transaction is a type error rather than a docstring nobody read.
- **Every IPC write runs in one `transact`**, in the `main/api/` module that builds its resource
  (`api.ts` is only the wiring table): a repository function given the bare `db` commits its
  change and its audit row as two statements, and a crash or failed audit insert between them
  leaves a change with no record.
- **Every mutation writes an audit entry in the same call**, with `before` on updates/deletes.
  `audit_log` is append-only in the file itself (migration 0013's triggers refuse UPDATE and
  DELETE); restore and start over replace the whole file instead.
  Denials, resolutions and overrides go through `recordAuditStrict`, which refuses to record
  without a stated reason — that text is what gets quoted if a decision is challenged.
- **Rule set versions are immutable.** `saveRuleSet` always inserts a new version; a published
  period snapshots the version it was solved under, so editing rules must never rewrite the
  rules an existing schedule was judged by.
- Bad data throws loudly (`ScheduleView` throws on an unknown nurse id). Silently dropping a
  row hides corruption; in scheduling that becomes a grievance.
- **Credit and licences travel with the code that needs them.** OR-Tools/CP-SAT and every library
  the runner bundles are listed in `native/cpsat-runner/THIRD_PARTY_NOTICES.md`, with full texts
  in `native/cpsat-runner/licenses/` that the CMake install copies into every bundle; research a
  solver technique comes from is cited in its module header and in README › Credits and
  references. Bundling a new library or adopting a published method means adding its entry.
- **`contractedHoursPerPeriod` is per pay period, not per schedule period.** A six-week
  period is three pay periods; anything comparing scheduled hours to the contract must scale by
  `periodDays / unit.payPeriodDays` (compliance alerts do; the under-hours rule works per pay
  period already).
- **Tests never use the demo as a fixture, and the scenario data must not change** — test
  expectations are pinned to it. Why, and how to add a scenario: `packages/db/src/seed/CLAUDE.md`.

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

- **`ROADMAP.md` is the plan of record** — milestones M1–M38, locked-in decisions, verification
  steps. Tick a box when the work lands *and* its verification passes, not when code is written.
- **`.claude/skills/scheduling-review`** — the domain review checklist for scheduling changes.
- `.claude/scripts/` — SessionStart roadmap summary and a non-blocking Stop-hook test run.
