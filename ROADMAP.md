# ShiftNurse — Nurse Scheduling Desktop App

## Context

A nurse manager today builds unit schedules by hand against union/contract rules — slow,
error-prone work where a mistake becomes a grievance. ShiftNurse generates a compliant
schedule for a scheduling period automatically, lets the manager override it, scores the
result for fairness across the team, handles the day-of disruptions that wreck a published
schedule, and when demand can't be met presents the conflict with concrete, ranked
resolutions rather than an error.

**v1 is manager-only by design.** Nurses do not log in. The manager records everything on
their behalf — time-off requests, shift exchanges, preferences — and hands out schedules as
printed grids and per-nurse sheets. A later phase adds nurse self-service (schedule viewer,
vacation requests, shift exchange marketplace). Every request type in v1 is therefore
modeled as *a request with a submitter and a decider*, so that later phase adds an intake
surface rather than a new data model. See **Future: nurse self-service** below.

### Decisions locked in

| Dimension | Decision |
|---|---|
| Users | Manager only. Nurses do not log in; the manager enters everything on their behalf. |
| Automation | Auto-generate a full period, then manual edit with live rule validation. |
| Platform | Local desktop app, Windows 11 + macOS. Later migration to web/mobile. |
| Scope | One unit, 20–60 nurses. |
| Shifts | Mixed 8h and 12h, differing contracted lengths, plus on-call/standby. |
| Hard rules | Rest & consecutive limits; contracted hours/FTE; skill & credential coverage; patient-ratio compliance. |
| Fairness inputs | Seniority weighting, historical balance, preference satisfaction, time-off approval equity, on-call burden. |
| Conflicts | Ranked resolution options, plus auto-resolve-with-audit-log below an impact threshold. |
| Shift exchange | 1:1 trades **and** giveaway/pickup. Hard-rule breaches blocked; fairness/soft impacts warn and can be overridden with a logged reason. |
| Solver | ~~Pure TypeScript engine (no Python runtime to bundle).~~ *Superseded by M15:* SA + LNS stays pure TypeScript; CP-SAT and the hybrid add a native OR-Tools runner (C++, built in CI, bundled per target). |
| Staffing demand | Full acuity model — acuity tiers, HPPD targets, census forecasting, ratio rules. |
| Day-of ops | Call-off handling with ranked replacement finder. |
| Cost | Pay rates, differentials, OT and agency premiums; dollar impact on every decision. |
| Data intake | Manual in-app entry **and** CSV import from day one. Historical seeding, demo dataset. |
| Output | Print/PDF grid, per-nurse sheets, CSV/Excel export, draft→publish lifecycle. |
| UI | React 18 + TypeScript + Vite, Radix primitives + Tailwind (shadcn approach), TanStack Router/Query. |
| Intent | Real use on a real unit, architected to become a product. |

### Stated assumptions

- *Weekend/holiday equity* is a heavily weighted **soft** objective, promotable to a hard
  rule through config without a code change.
- Auto-resolve ships **off** by default; enabling it applies only below the configured
  impact threshold, and always writes its reasoning to the audit log.
- Installers are unsigned initially — expect Gatekeeper/SmartScreen warnings. Signing later.
- Ratio rules ship as a seeded, fully editable table using California-style med-surg ratios
  as an example. Your jurisdiction's actual ratios are configuration, not code.
- **npm workspaces, not pnpm** (pnpm is not installed on this machine; npm workspaces are
  also the safer pairing with Electron and native modules).

---

## Architecture

The rule engine, solver, acuity model, fairness and cost logic live in a **pure TypeScript
package with zero Electron and zero database dependencies**. That is what makes the later
move to a web/mobile backend a re-host rather than a rewrite.

```
shiftnurse/
├── packages/
│   ├── core/          # domain: rules, acuity, solver, fairness, conflicts, cost. Pure TS.
│   └── db/            # Drizzle schema + migrations + repositories (better-sqlite3)
└── apps/
    └── desktop/
        ├── main/      # Electron main: DB ownership, IPC handlers, solver worker, backups
        ├── preload/   # contextBridge — typed, narrow IPC surface, contextIsolation on
        └── renderer/  # React + Vite + Radix + Tailwind + TanStack Router/Query
```

- **Electron** over Tauri: no Rust toolchain, the solver is already TS, one language end to end.
- **better-sqlite3 + Drizzle ORM**, database owned by the main process only. Drizzle's dialect
  abstraction targets Postgres when this becomes a web app.
- Renderer never touches the DB or filesystem; everything goes through typed IPC whose
  contract is shaped like the future HTTP API.
- **electron-builder** → `.dmg` (x64 + arm64) and NSIS `.exe`.

---

## Current state

`packages/core`, `packages/db` and `apps/desktop` through M16 are green: lint, typecheck and the
full test suite pass in CI on Linux, macOS and Windows (`npm run check`; no count kept here — it
went stale within a milestone the last time).

- [x] Monorepo scaffold (npm workspaces, TS project references, vitest)
- [x] `domain/time.ts` — DST-safe wall-clock timeline, shift windows, configurable weekend definitions
- [x] `domain/entities.ts` — full entity model
- [x] `acuity/demand.ts` — census + acuity → staffing demand, ratio maths, coverage floors
- [x] `schedule/view.ts` — indexed read model with prior-period lookback
- [x] `rules/` — registry + all 8 hard rules, severity overrides, rule-set versioning
- [x] `fairness/` — ledger derivation, decayed burden index, seniority multiplier, 0–100 score, Gini
- [x] `cost/` — rate resolution, itemised per-shift pricing with stacked differentials and daily/weekly overtime, marginal cost of a candidate, overtime concentration, budget variance
- [x] `testing/fixtures.ts` — scenario builder reused by tests and the demo seeder

---

## Shift exchange

Recorded by the manager on a nurse's behalf; later opened to nurses directly.

- **1:1 trade** — two nurses exchange specific shifts. Both sides are re-validated through
  the existing rule engine: rest, consecutive limits, weekly hours, FTE, credentials, charge
  coverage, and the ratio/coverage impact on both affected shifts.
- **Giveaway / pickup** — one nurse drops a shift and a named nurse takes it. No shift comes
  back, so this moves hours between nurses: FTE targets and the overtime threshold are the
  checks that matter most, and the cost engine prices any overtime the pickup creates.
- **Decision policy** — a hard-rule breach blocks the exchange and names the rule. Fairness
  and soft-rule impacts are shown as a before/after warning that the manager can approve
  anyway, with their reason captured in the audit log.

Entities: `shift_swap` (kind, requesting nurse, counterparty, the assignment(s) involved,
status, submitted/decided timestamps, `enteredBy`, decision reason).

---

## Future: nurse self-service

Not built in v1, but the seams are preserved now so the later phase is additive:

- Every request — time off, shift exchange, open-shift pickup — carries a submitter, a
  status and a decider. v1 sets `enteredBy: 'manager'`; self-service sets `'nurse'` and
  reuses the identical approval workflow, tables and validation.
- `packages/core` stays free of Electron and DB imports, so it becomes the server engine.
- The IPC contract is shaped like a REST/tRPC surface, so the renderer can be repointed.
- Per-nurse schedule rendering already exists in v1 as the per-nurse PDF sheet; the nurse
  schedule viewer reuses that same projection.

---

## Milestones

### M1 — Core domain ✅
- [x] Monorepo, TypeScript config, vitest harness
- [x] Time model with DST/midnight/weekend handling
- [x] Entity definitions
- [x] Acuity → demand derivation
- [x] Schedule read model
- [x] Rule engine + 8 hard rules + tests

### M2 — Data layer ✅
- [x] `packages/db`: Drizzle schema for every entity in `core/domain/entities.ts` (26 tables)
- [x] Migrations generated, WAL mode, foreign keys enforced, transaction helper
- [x] Repository functions per aggregate — `roster`, `config`, `schedule`, `timeoff`, `operations` — each under test
- [x] Append-only `audit_log` writer; denials/overrides refuse to record without a reason
- [x] Demo seed: 42-nurse unit, 6 months of history, census actuals, planted PTO conflict and expiring credentials, deterministic per seed
- [x] Verify: `npm run seed:demo` produces a queryable database (0.4s; 3.4k assignments, zero double-bookings, hours within 0.5% of contract)

### M3 — Electron shell ✅
- [x] `electron-vite` main/preload/renderer build
- [x] Main process opens the database in `userData` via `openDatabase` from `@shiftnurse/db`
- [x] Typed IPC bridge with `contextIsolation`, renderer has no direct DB/FS access
- [x] React + TanStack Router shell, Radix + Tailwind design tokens, light/dark
- [x] App boots to a dashboard reading real seeded data
- [x] Install the React-specific skills deferred from tooling setup, now that a renderer
      exists to apply them to: `vercel/react-best-practices` and
      `vercel-labs/web-interface-guidelines` (deferred deliberately — an installed skill
      costs context in every session, so it should not be carried before it is useful).
      Both now live in `vercel-labs/agent-skills`; vendored at a pinned commit under
      `.claude/skills/`, with `web-design-guidelines` rewritten to read a local copy of its
      rules instead of fetching from GitHub `main` on every review

### M4 — Roster & configuration ✅
- [x] Nurse CRUD: FTE, seniority, role, employment type, charge/novice flags, contact
- [x] Credentials with expiry; preferences editor
- [x] Shift type editor (8h, 12h, on-call), coverage floors by weekday, holiday calendar
- [x] CSV import **and** export for the roster, reusing one parser
- [x] Verify: import 60 nurses from CSV, round-trip through export

### M5 — Acuity & demand ✅
- [x] Acuity tier editor, ratio rule table with citations, HPPD target
- [x] Census forecast entry per date × shift, with acuity mix validation
- [x] Historical forecaster (day-of-week + seasonal moving average) proposing values
- [x] Derived-demand view showing which constraint binds each number
- [x] Forecast-vs-actual back-test
- [x] Verify: a high-acuity mix raises required staffing above the coverage floor

> **Follow-up (found in M9):** ratio demand is derived per (date, shift type), so overlapping
> shift types that both carry a census forecast (a D8 inside a D12) each demand a full complement
> for the same patients. The demo now forecasts only the two 12-hour shifts; the proper fix is
> concurrent time-of-day coverage, which M10's conflict detector is the natural home for.

### M6 — Schedule grid & live validation ✅
- [x] Nurses × days grid, mixed shift lengths, colour-coded
- [x] Drag-and-drop assignment, cell locking
- [x] Live violation badges per cell, row and column, driven by the existing rule engine
- [x] Rules configuration screen: hard-rule params, soft weights, severity overrides
      (params + enable/disable + severity overrides + weekend definition, versioned saves;
      soft-rule *weights* land with M7 since every shipped rule is hard today)
- [x] Verify: dragging a shift to break minimum rest turns the cell red immediately

### M7 — Fairness ✅
- [x] `core/fairness`: per-nurse 0–100 composite with explainable component breakdown
      (eight components; each carries carried-vs-fair-share and a sentence for the UI)
- [x] Seniority as a multiplier on preference weight, not an absolute override
- [x] Rolling historical burden from `fairness_ledger`; signed burden index for the solver
      (13-period window, 0.85 decay; fair share pinned to contracted hours so the score is monotone)
- [x] Unit-level distribution (Gini + min/max spread), per component and over the composite
- [x] CSV import of historical schedules to seed the ledger (`employee_id,date,shift`, bucketed
      into pay periods, derived with the same `deriveCounters` a publish will use)
- [x] Fairness screen: per-nurse breakdown and trend; soft weights editable and versioned with
      the rule set (the M6 deferral)
- [x] Verify: fairness monotonicity — a worse assignment never raises a nurse's score
      (property test over random rosters through `deriveCounters` → `scoreFairness`, plus the
      same check against seeded data in the smoke test)

### M8 — Cost ✅
- [x] Pay rates, night/weekend/holiday/charge/on-call differentials, OT rules, agency premiums
      (repositories with audit, `cost` IPC resource, Settings › Pay editor; rates are dated so a
      raise never re-prices earlier shifts)
- [x] Costing function over any schedule or candidate assignment (`costSchedule` /
      `marginalCost`: flats add to base, multipliers scale `(base + flats)`, overtime is an
      FLSA-style premium on the straight rate, an hour is overtime once, weekly OT lands on the
      later shifts and counts the lookback tail)
- [x] Budget vs. actual on the dashboard; overtime concentration by nurse (ranked shares,
      top-three share, Gini; running cost strip on the Schedule page re-prices on every edit)
- [x] Verify: hand-computed payroll scenarios with stacked differentials match (31 core tests
      with hand-worked dollar figures; smoke test prices seeded history to $149k with nothing
      unpriced and sees +$576 for one added weekday D12)

### M9 — Solver ✅
- [x] `Solver` interface so a CP-SAT backend can be swapped in later (`solver/types.ts`: plain-data
      `SolveInput` → `SolveReport`; `localSearchSolver` is the shipped implementation)
- [x] Greedy seed: most-constrained slot first, highest fairness debt wins (dynamic eligibility
      counts that see leave, the day, the pay-period cap and the weekly overtime threshold; ties go
      to the objective delta, where the coverage term cancels and fairness debt decides)
- [x] Simulated annealing / large-neighbourhood search over the weighted objective (reassign,
      swap, add, remove, relocate, convert-12-to-8s moves — 70% aimed at short shifts and
      under-hours nurses — plus a two-day ruin-and-recreate every 2,500 iterations; rules are
      evaluated incrementally on single-nurse / single-shift views via the new `Rule.scope`)
- [x] Runs in a worker thread with progress and cancellation; seeded RNG for determinism
      (`main/solver-worker.ts` via electron-vite `?nodeWorker`, cancel through a shared
      `Int32Array`, `solver.start/status/cancel` IPC polled by the renderer; seed defaults to a
      hash of the period id)
- [x] Generate flow honouring locked cells; solve report with unfilled slots and cost
      (Schedule › Generate: confirm → live progress with Stop → report of unfilled slots,
      hard/soft counts, fairness and cost; result applied in one `replaceAssignments` transaction)
- [x] Verify: property test — solver output never violates a hard rule; re-running
      unchanged inputs produces an identical schedule (24 core tests incl. random-unit property
      test re-judged by the full engine; smoke test generates the demo draft twice in ~1s each with
      the locked row kept and byte-identical output; full budget on the demo unit fills every floor)

### M10 — Time off & conflicts ✅
- [x] Time-off request entry and queue; calendar heatmap of overlapping requests
- [x] Approve/deny showing projected staffing impact before deciding; denial reason required
- [x] `ConflictDetector`: understaffing, ratio breach, competing PTO, FTE, credentials, budget
- [x] `ResolutionGenerator`: each option simulated for coverage, fairness **and** dollar impact
- [x] Ranked resolution cards; auto-resolve threshold (off by default) with audit logging
- [x] Verify: over-approving PTO on one weekend surfaces ranked options with real deltas
      (`core/conflicts/analyse.test.ts` asserts the scenario; the smoke test exercises
      `timeOff.impact`, `conflicts.analyse` and a policy-off `autoResolve` on the demo draft)

> **Note:** the smoke's conflict/option counts differ run to run because a fresh `userData`
> mints a new demo period id and therefore a new solver seed; within a run analysis is
> byte-identical on rerun. The M5 follow-up (concurrent time-of-day coverage across
> overlapping shift types) is still open — the detector reads demand per (date, shift type).

### M11 — Shift exchange ✅
- [x] `shift_swap` entity and repository (`core/exchange/types.ts` is the contract;
      `db/repositories/exchange.ts` — the assignment ids carry no FK because an approval
      replaces the original rows and the swap must keep pointing at the historical ids)
- [x] 1:1 trade and giveaway/pickup entry, manager-recorded (Requests › Exchanges, with a live
      evaluation panel in the proposal dialog)
- [x] Re-validation of both nurses through the rule engine; hard breaches block with reason
      (`evaluateExchange` simulates on the M10 `ConflictEngine`; `approve` re-evaluates
      server-side and never trusts a renderer verdict)
- [x] Fairness and cost before/after preview; override path captures a reason
      (`warn` needs a reason and sets `overrode`; the audit entry is written before any row)
- [x] Audit entries for every proposal and decision
- [x] Verify: a trade breaking minimum rest is refused; a legal-but-unfair one warns and can
      be approved with a logged reason (`core/exchange/evaluate.test.ts`; the smoke test
      proposes a trade on the demo draft, approves the `warn` verdict with a reason, denies a
      blocked one, and confirms a blank denial is refused)

### M12 — Publish & output ✅
- [x] Draft → published lifecycle with diff against the previous published version
      (`schedule_version` freezes the assignments per publication; `core/publish/diff.ts` keys
      the diff on nurse/date/shift so a regenerate with new row ids is "no change"; a republish
      needs a reason and refuses when nothing changed; publish also books the fairness ledger
      through the same `deriveCounters` scoring and import use)
- [x] Change log with reasons for every post-publish edit (`schedule_change`; main's
      `editSchedule` wraps every grid mutation, refuses a published-period edit without a reason,
      and exchange approvals on a published period log as `source: 'exchange'`; the board
      collects the reason in a dialog before each edit)
- [x] PDF unit grid + per-nurse schedule sheets (`core/publish/output.ts` projections →
      `main/print-html.ts` → Chromium `printToPDF` in a sandboxed hidden window)
- [x] CSV/Excel export (grid CSV, long CSV in the history-import format so an export re-imports,
      and a dependency-free xlsx writer in `main/xlsx.ts`)
- [x] Compliance alerts: credential expiry inside the period, FTE/OT drift, ratio-risk days
      (`core/publish/compliance.ts`; contract hours scaled to the schedule length; ratio-risk only
      where a patient ratio binds, not a coverage floor the solver fills to on purpose)
- [x] Automatic backups on publish, rolling daily backup, one-click restore (`main/backups.ts`
      via SQLite's online backup API; 14 dailies kept; restore saves a `pre-restore` copy and
      relaunches; Settings › Backups)
- [x] Verify: publish, edit, and confirm the change log and audit entries tell the full story
      (`db/repositories/publish.test.ts`; the smoke test publishes the generated demo draft, sees
      a reasonless edit refused, edits with a reason, reads the change log, republishes as v2 with
      the +1/−0/~0 diff, and renders the grid PDF, nurse-sheet PDF and xlsx headlessly)

### M13 — Day-of console ✅
- [x] "Today" screen: current and next shift, actual census entry, live ratio re-check
      (`core/dayof/staffing.ts`: `shiftsAround` on the wall-clock timeline — a night shift
      running at 03:00 is yesterday's slot — and `checkStaffing`, which swaps the actual census
      into the same `deriveDemand` the Demand page uses; `dayOf.today` IPC; Today page)
- [x] Report a call-off against an assignment (`call_off` now carries period/nurse/shift/date
      beside the assignment id with no FK, migration 0005 — a backfill replaces that row and the
      record must outlive it, as `schedule_change` does)
- [x] Ranked replacement finder: eligibility → cost → fairness debt → recency of last call
      (`core/dayof/replacements.ts` simulates every same-role nurse on the conflicts engine —
      straight time first, authorised overtime only when that is all that stands in the way —
      and orders lexicographically: pay tier, marginal cost, burden index, least-recently called;
      the excluded list names the rule for each nurse ruled out)
- [x] Call log with outcomes, feeding the fairness ledger (`call_attempt` per call; the backfill
      row is `source: 'callout'`, which `deriveCounters` books as a call-out covered on publish)
- [x] Backfills flow through the published-schedule change log (`dayOf.backfill` re-runs the
      finder inside `editSchedule` before writing, logs `removed` + `added` as `source: 'backfill'`
      with the absent nurse's call-off as the reason; uncovered/cancel audit before they write)
- [x] Verify: the replacement list excludes rest-noncompliant and uncredentialed nurses and
      orders straight-time before overtime before agency (`core/dayof/replacements.test.ts`;
      the smoke test reports a call-off on the published demo period, checks the ranked list is
      eligible-only and tier-ordered, backfills the top candidate and reads the change log)

### M14 — Packaging ✅
- [x] electron-builder config for Windows 11 (NSIS) and macOS (dmg, x64 + arm64)
      (`apps/desktop/electron-builder.yml`; `npm run dist` builds both mac dmgs, `npm run dist --
      --win --x64` cross-builds the NSIS installer from macOS with no wine; Electron pinned exact
      because electron-builder refuses a range; everything electron-vite bundles moved to
      devDependencies so the asar carries only `better-sqlite3-electron`, `drizzle-orm` and
      `@electron-toolkit/utils` — 23 MB → 8 MB. Since PR #6 `drizzle-orm` is bundled into the
      main process instead, so the `better-sqlite3` alias applies to it; the asar's runtime
      dependencies are `better-sqlite3-electron` and `@electron-toolkit/utils`)
- [x] Native module rebuild for better-sqlite3 against the Electron ABI
      (`npmRebuild: false` — electron-builder's own rebuild recompiled the *hoisted* copy and broke
      `npm test`; `scripts/before-pack.mjs` fetches the prebuild for each *target* platform/arch
      through the same `rebuild-sqlite-for-electron.mjs` postinstall uses, and `scripts/dist.mjs`
      restores the host binary in a `finally` so `npm run dev` survives a dist run)
- [x] Verify: install and launch the built artifact on macOS
      (both dmgs mounted, `ShiftNurse.app` copied out and booted via `npm run smoke:packaged` —
      arm64 passes the full smoke natively: migrations from `resources/`, native module, solver,
      publish, PDFs; x64 under Rosetta renders every screen and runs the solver but exceeds the
      smoke's 60 s budget under emulation — the budget is now 240 s, raised further in CI through
      `SHIFTNURSE_SMOKE_TIMEOUT_MS`)
- [x] Verify: install and launch the built artifact on Windows 11
      (the NSIS installer builds from macOS and carries the win32-x64 `.node`, but no Windows
      machine was available to install and launch it — needs real Windows 11 hardware.
      M16: the packaged app now boots and passes its full self-test on `windows-2022` in CI, run
      from outside the repo. The first real Windows 11 install (v0.1.0's first draft) crashed on
      launch — fixed in PR #6. Verified: the fixed installer installs and launches on a native
      Windows machine.)

### M15 — Selectable solvers ✅
Plan of record with checkable steps: [`docs/SOLVER_PLAN.md`](docs/SOLVER_PLAN.md). Three backends
behind the existing `Solver` seam, chosen per unit in Settings › Solver with a per-run override:
**Hybrid** (default — annealing with CP-SAT re-optimising small windows), **SA + LNS** (the current
engine plus the Ceschia/Guido/Schaerf block moves; the only one needing no native binary) and
**CP-SAT** (exact, with an optimality gap). Fallback: hybrid, then whichever of SA+LNS / CP-SAT
the benchmark ranks higher.
- [x] Phase 1 — solver registry, `solver_settings` table, IPC, Settings › Solver, Generate override
- [x] Phase 2 — SA + LNS: block-swap and multi-day reassign moves
- [x] Phase 3 — OR-Tools C++ runner, GitHub Actions build, per-target bundling, main-process client
- [x] Phase 4 — CP-SAT backend: pure encode/decode in core, an encoder for every registered rule
- [x] Phase 5 — Hybrid backend, `bench:solvers`, fallback order set from measured results
- [x] Phase 6 — CLAUDE.md, README, ARCHITECTURE, credits and bundled licences
- [x] Generate variations — a batch of 1–10 seeds held as candidates (not written until saved),
      time estimate per solver, candidates bar with grid preview, comparison against the draft,
      stale-input detection, the grid's schedule scored as a contender, "Generate more" with new
      seeds; verified by `api/solver.test.ts` and the smoke run's Generate UI step
- [x] Verify: every backend passes the property suite (no nurse-scope hard violation, same seed →
      identical schedule, locks preserved); Generate fills every floor on the demo with each;
      `smoke:packaged` green on mac with the runner bundled

### M16 — CI/CD and GitHub releases ✅
Plan of record with checkable steps: [`docs/CI_PLAN.md`](docs/CI_PLAN.md). CI (lint and typecheck
on Linux; tests on Linux, macOS and Windows) on every push and pull request, required before
merging into `main`; a `vX.Y.Z` tag builds and smoke-tests the mac arm64, mac x64 and Windows x64
installers natively on GitHub and attaches them to a **draft** release. Unsigned for now.
- [x] Phase 1 — `ci.yml`: lint, typecheck, tests on three OSes; Windows `tar` pin in the runner fetch
- [x] Phase 2 — `release.yml`: native builds + packaged smoke per platform, draft release with SHA256SUMS
- [x] Phase 3 — branch protection on `main`; first draft release `v0.1.0`
- [x] Phase 4 — README, CLAUDE.md, ARCHITECTURE
- [x] Verify: CI green on branch, PR and `main`; a failing PR is blocked; the `v0.1.0` draft carries
      three installers whose `SHA256SUMS` verify, and one installs and runs locally

### First-run setup ✅
A fresh install used to seed a fictional 42-nurse unit into every real database. It now opens a
welcome screen: explore the demo, set up a bare unit manually, or follow the guided setup, whose
every step offers one-click starting points and can be skipped. Settings › Unit reopens the guide
and can start over (after a `pre-reset` backup).
- [x] Core: `setup/` — step order and `setupPhase`, shift/acuity/coverage presets, US federal
      holidays (test-first, hand-checked dates)
- [x] DB: `setup_state` (migration 0008), `repositories/setup.ts` — demo/unit starts refuse over an
      existing unit, idempotent audited presets
- [x] Main/IPC: `setup` resource, `units.update`, Start over via `resetDatabase`; no seeding at open
- [x] Renderer: setup gate, welcome screen, assisted guide embedding the Settings editors,
      Settings › Unit
- [x] Verify: `npm run check` green; smoke passes from an empty database (welcome → demo →
      dashboard, then the guide walked end to end)
- [ ] Verify by hand: a guided setup on a fresh `userData` applying every preset, quit and resume
      mid-guide, Generate fills the floors of a new period; Start over returns to the welcome
      screen and its `pre-reset` backup restores
- [x] Realistic demo (`seed/demo.ts`): a 28-bed med-surg unit sized from real staffing practice;
      the planted-problem dataset moved unchanged to `seed/scenarios.ts` (fingerprint of its
      output identical before and after) for tests, the benchmark, `npm run seed:scenarios` and a
      dev-only "Load test scenarios" welcome option
- [x] Verify: `demo.test.ts` — history legal under the rule engine, no ratio breach, every past
      shift priced within 6% of budget, Generate fills every floor of the draft; smoke passes on
      the new demo (hybrid and SA + LNS 0 unfilled)
- [x] A choice of demo units: the demo became a profile-driven engine; the welcome screen lists
      community med-surg, a VA San Francisco medicine-surgery ward (six 12s and an 8 a pay
      period with overtime over the pay period, LVNs, no ratio law, Title 38 premiums, federal
      holidays and pay calendar) and a California ICU
      (Title 22 1:2/1:1, ACLS for all, 12-hour alternative workweek)
- [x] Verify: `seed/demo/*.test.ts` — the shared realism checks on every unit (legal history,
      Generate fills every floor) plus each unit's own facts, Title 38 pay factors computed by
      hand; mutating the weekend premium or pay calendar fails them; smoke picks a unit from the
      list

### Leave by shift and paid leave hours ✅
Leave is booked against the shifts dated in it, as unit scheduling systems do, and paid leave
counts toward contracted hours — a nurse back from a paid week off is not "36 hours short".
- [x] Time-off rule: the night into leave's first morning counts only where a rule set makes a
      day off a whole calendar day (off by default), judged by the shift's end, not its night flag
- [x] Paid hours on leave requests (suggested as the shifts the nurse would have worked) and
      paid sick hours on call-offs (migration 0009); a "sick" leave type
- [x] Contracted-hours rule credits paid leave; the max-hours rule counts it toward overtime only
      when a contract says so, never toward the weekly cap — rule engine, solver model, CP-SAT,
      cost engine and compliance alerts all read the one credit
- [x] Demos: paid leave and sick pay, a removal check in the history scheduler, realistic
      per-diem pools; under-contract readings fell from 8–15% of nurse-pay-periods to under 5%
- [x] Verify: rule, parity (400 random rosters with leave, both settings), solver and model tests
      written first and mutation-checked; `npm run check`; `npm run bench:solvers` re-run —
      rankings unchanged; synthetic-24 identical; small-8's hybrid fills one more floor because
      the night before its nurse's leave is now available; the scenario row moves within its
      run-to-run noise (random UUIDs; the leave settings were checked to have no effect on it)

### Incompatible staff ✅
Managers keep some nurses off the floor together — a clash, an HR investigation — and the
problem is often a group of three or more, not a pair.
- [x] `IncompatibilityGroup` (members, `maxTogether`, reason, optional start/end dates);
      `incompatibility_group` + `incompatibility_member` (migration 0011); repository refuses a
      group of one, another unit's nurse, a cap that allows everyone, and any change without a
      reason (audited)
- [x] "Together" is by the hour (`schedule/overlap.ts`): a mid overlapping a day 12 counts, a
      night ending at 07:00 does not overlap the 07:00 day
- [x] Two rules: `incompatible-staff-cap` (soft: more members on at once than the cap) and
      `incompatible-staff-buffer` (hard: while members overlap, `minOutsideStaff` — default 2 —
      from outside the group on the floor every shared hour); the reason never appears in a
      violation
- [x] Solver prices both per person-hour over floor stretches (`SolverModel.stretches`), CP-SAT
      term for term; conflicts engine judges overlapping rosters, so backfill cards warn and
      exchanges block the same way the grid does
- [x] Roster › Kept apart (create/edit/remove with reason), groups on the nurse drawer;
      `minOutsideStaff` on Settings › Rules
- [x] Verify: rule, overlap, model cache-vs-rebuild, CP-SAT parity (hand-worked prices, random
      rosters, annealer schedules), backfill, repository and grid tests written first and
      mutation-checked; `npm run check`; `npm run smoke`. `bench:solvers` not re-run: with no
      groups every new term is zero and no rule list changes, so its inputs price identically

### M17 — Signed installers and updates (deferred)
Deferred by decision (2026-10-03): 1.0 ships unsigned with install instructions (M18 › Phase 8);
the icon moves to M18. v0.1.0 ships unsigned: macOS users are told to run `xattr` and Windows users to click past
SmartScreen, and an installed copy has no way to learn that a fix exists — the crash-on-launch
fix in PR #6 reached nobody who had already installed the first draft. Nothing here is started.
- [ ] Apple Developer ID signing with hardened runtime and entitlements, and notarisation
      (`notarize: true`), wired to repository secrets in `release.yml`
- [ ] Windows Authenticode signing (e.g. Azure Trusted Signing) for the NSIS installer
- [ ] `electron-updater` with `publish: github`: `latest*.yml` and blockmaps in the release,
      a "restart to update" prompt, never an unattended restart mid-shift
- [ ] An app icon (`apps/desktop/build/icon.{icns,ico,png}`) — installers use Electron's default
      (drawn: `build/icon.png` from `scripts/make-icon.mjs`; tick once a packaged build shows it)
- [ ] An in-app "new version available" banner from GitHub's latest release (`main/updates.ts`;
      tick once a packaged v0.1.x has shown it for a published v0.1.y)
- [ ] Verify: a signed dmg opens without a Gatekeeper prompt on a clean Mac; the signed installer
      passes SmartScreen on real Windows 11; v0.1.x updates itself to v0.1.y from a draft release

### M18 — Release hardening (in progress)
The 2026-10-03 release audit: data safety, renderer correctness, maintainability, tests, the
manager's experience and the contract rules a real hospital would check first. One PR per phase.

**Phase 1 — Data safety and robustness**
- [x] Backups written to `.partial`, `quick_check`ed, then renamed; quit waits for one in flight
- [x] Restore refuses a damaged backup or one from a newer version; the restore is audited in the
      restored database
- [x] Backup trash moves and their audit rows succeed or fail together
- [x] The CP-SAT runner is killed on a failed start, a hung solve and a crashed worker
- [x] Hardening: CSP `object-src`/`base-uri`/`form-action`, redirect and frame navigation guards,
      permission check handler, smoke harness loaded only in a smoke run, xlsx control characters
- [x] Every patch goes through an allow-list (`updatePayRate`, conflict policy, solver settings)
- [x] Every IPC call's arguments are checked at runtime (`shared/schemas`, zod) before main runs it
- [x] Time off loaded for the period and its lookback only; Generate's freshness check recomputes
      the fingerprint only after a write
- [x] Verify: `npm run check` (1,283 tests); `npm run smoke`; `npm run dist` + `smoke:packaged`
      (mac arm64); SA + LNS output unchanged on fixed inputs (no core change in this phase)

**Phase 2 — Renderer correctness**
- [x] Configuration edits refresh every read model derived from them (`invalidateUnitDerived`);
      publish no longer refetches the whole app
- [x] A failed save always reaches the manager (toast for any mutation without an inline error)
- [x] Undo for grid edits (toast + Cmd/Ctrl-Z), published edits carrying an "Undo:" reason
- [x] `board.tsx` split into edit, generate and dialog hooks; shared `Modal`, `EditorShell`,
      `DateField`; instants formatted once
- [x] Verify: invalidation matrix and mounted-query tests, 17 undo tests (incl. concurrent edits),
      `npm run check` (1,386 tests), `npm run smoke`

**Phase 3 — The manager's experience**
- [x] Settings grouped (My unit, Contract & pay, Scheduling, Data) with links from where the
      question comes up; navigation in workflow order with a pending-requests badge
- [x] Generate says "options", not variations or seeds; unfilled shifts explained in words
- [x] Fairness lists the actual nights, weekends and holidays, with "Show on schedule"
- [x] Violation chips distinguishable without colour; 12px minimum on the grid at 1366×768
- [x] "Someone called off" as the first action on Today
- [x] Status banners collapsed into one row of pills so the grid has the screen at 1366×768
- [x] Verify: `npm run check` (1,416+ tests); `npm run smoke`; screenshots at 1366×768 (five nurse
      rows and the staffing footer visible, up from two or three)

**Phase 4 — Core maintainability**
- [x] Typed rule parameters (`paramsOf`/`requireParams`/`asParams`; no `as unknown as` params
      outside the one accessor) and violation details read through `detailNumber`/`detailString`,
      which refuse a missing value instead of reading it as zero
- [x] `SolverModel`'s fixed setup (shifts, work calendar, hours buckets, pay context, carried
      history) moved to `model-setup.ts`; shift types by map. The incremental pricing state stays
      in the class: splitting it further risks the hash-identical guarantee for little gain
- [x] Soft-rule pricing parity test between the rule engine and `SolverModel` (every natively
      soft rule accounted for)
- [x] `dayNumber` refuses a malformed date; memo caches bounded; `defaultRuleSet` takes its clock
- [x] Conflicts analysis: fairness scored by `FairnessEvaluator` (bit-identical to
      `scoreFairness`), a fix priced against the state it came from, indexes instead of `.find`
      in loops — 2.5 s → ~640 ms on the scenario period; auto-resolve applies independent fixes
      per analysis (minutes → seconds). Target was < 500 ms: the rest is one full `ScheduleView`
      per simulated fix, which needs a copy-on-write view (follow-up below)
- [ ] Follow-up: copy-on-write `ScheduleView` for simulated fixes, to reach < 500 ms
- [x] Named core exports (243, from ~470); conflicts engine indexes and `resolve.ts` split into
      candidates and scoring; shared audited update in `packages/db`
- [x] Verify: SA + LNS output hashes unchanged on fixed inputs after every solver-touching change;
      deterministic conflicts fixture hash unchanged; `bench:solvers` re-run

**Phase 5 — Tests**
- [ ] Renderer harness (fake bridge) and dialog tests: decide, publish, generate/save, call-off,
      new period, rules, assisted setup
- [ ] IPC channel-table test; DST and leap-day solver/cost/fairness tests; leave and day-of API
      cases; property tests (diff, exchange, locks, dates, overtime)
- [ ] Coverage run passes first time; CP-SAT suites required on one CI leg; desktop main ≥ 70%
- [ ] Smoke: generate→save, leave with cover, undo, call-off button, settings groups

**Phase 6 — Contract rules for 1.0**
- [ ] A charge nurse without patients does not count toward the ratio (`chargeNurseTakesPatients`)
- [ ] Break relief so ratios hold at all times (`breakMinutesPerNurse`)
- [ ] California overtime: daily by workday, banded 1.5×/2×, seventh day
- [ ] No mandatory overtime: volunteer records and the `mandatory-overtime` rule
- [ ] Weekend pattern rule (every other weekend, weekends per period)
- [ ] Credential expiry day judged the same everywhere; 30-day look-ahead; the Dashboard's
      next-steps count agrees with its "Credentials expiring" tile (1 vs 9 on the demo)
- [ ] Posting lead time; jurisdiction presets (CA, OR, NY, MA) with citations
- [ ] Stated limits: what 1.0 does not enforce, in the app and the README

**Phase 8 — Distribution without signing**
- [ ] App icon in the dmg and installer
- [ ] Install instructions for unsigned builds; checksums in the release

### M19–M26 — Union and HR features (after 1.0)
Each is a milestone of its own: core algorithm and rules test-first, then entity, IPC and UI.
- [ ] M19 Seniority leave bidding (bid rounds awarded in seniority order, every denial reasoned)
- [ ] M20 Low-census cancellation order (policy tiers, rotation in the ledger, Today flow)
- [ ] M21 Float pool and multi-unit staff (other-unit shifts as busy time, float rotation)
- [ ] M22 Leave balances and FMLA (accrual, certifications, balance warnings)
- [ ] M23 Pay realism (missed-break premium, call-back, minimum reporting and on-call pay)
- [ ] M24 Pooled licensed-nurse ratios with a minimum RN share
- [ ] M25 Preceptor pairing rule
- [ ] M26 Grievance export of the audit trail

---

## Verification

- `npm test` — core rule, acuity, fairness, cost and solver suites, including property tests.
- `npm run dev` — Electron boots on the first-run welcome screen; "Explore the demo" loads the sample unit.
- End-to-end manual pass:
  1. Enter a high-acuity census → derived demand rises above the coverage floor.
  2. Generate a 6-week period → zero hard violations, everyone within FTE tolerance,
     projected cost shown against budget.
  3. Over-approve PTO on one weekend → ranked resolutions with coverage, fairness and
     dollar deltas → apply one.
  4. Drag a shift to break minimum rest, and another to breach ratio → both flag immediately.
  5. Record a 1:1 swap that breaks rest → refused with the rule named. Record a legal one →
     approved, with fairness before/after shown.
  6. Publish → PDF grid, per-nurse sheets, CSV export, change log, audit entries.
  7. Report a call-off on the Today screen → ranked, eligible-only replacement list.
  8. Expire a credential inside the period → compliance alert names affected assignments.
- Determinism: re-run Generate on unchanged inputs → identical schedule.
- `npm run dist` on macOS and Windows 11; install and launch each artifact.

---

## Keeping this file current

Tick a box when the work lands and its verification step passes, not when the code is
written. The plan of record lives here.
