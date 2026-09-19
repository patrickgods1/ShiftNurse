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
| Solver | Pure TypeScript engine (no Python runtime to bundle). |
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

`packages/core`, `packages/db` and `apps/desktop` through M8 are green: **332 tests passing, typecheck clean.**

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

### M11 — Shift exchange
- [ ] `shift_swap` entity and repository
- [ ] 1:1 trade and giveaway/pickup entry, manager-recorded
- [ ] Re-validation of both nurses through the rule engine; hard breaches block with reason
- [ ] Fairness and cost before/after preview; override path captures a reason
- [ ] Audit entries for every proposal and decision
- [ ] Verify: a trade breaking minimum rest is refused; a legal-but-unfair one warns and can
      be approved with a logged reason

### M12 — Publish & output
- [ ] Draft → published lifecycle with diff against the previous published version
- [ ] Change log with reasons for every post-publish edit
- [ ] PDF unit grid + per-nurse schedule sheets
- [ ] CSV/Excel export
- [ ] Compliance alerts: credential expiry inside the period, FTE/OT drift, ratio-risk days
- [ ] Automatic backups on publish, rolling daily backup, one-click restore
- [ ] Verify: publish, edit, and confirm the change log and audit entries tell the full story

### M13 — Day-of console
- [ ] "Today" screen: current and next shift, actual census entry, live ratio re-check
- [ ] Report a call-off against an assignment
- [ ] Ranked replacement finder: eligibility → cost → fairness debt → recency of last call
- [ ] Call log with outcomes, feeding the fairness ledger
- [ ] Backfills flow through the published-schedule change log
- [ ] Verify: the replacement list excludes rest-noncompliant and uncredentialed nurses and
      orders straight-time before overtime before agency

### M14 — Packaging
- [ ] electron-builder config for Windows 11 (NSIS) and macOS (dmg, x64 + arm64)
- [ ] Native module rebuild for better-sqlite3 against the Electron ABI
- [ ] Verify: install and launch the built artifact on both platforms

---

## Verification

- `npm test` — core rule, acuity, fairness, cost and solver suites, including property tests.
- `npm run seed:demo && npm run dev` — Electron boots with the sample unit loaded.
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
