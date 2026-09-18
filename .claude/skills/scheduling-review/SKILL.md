---
name: scheduling-review
description: Domain-specific review checklist for ShiftNurse scheduling code — time/DST correctness, rule severity and registration, fairness monotonicity, solver determinism, audit completeness, core/Electron/DB boundary, and patient-ratio safety. Use after changing anything under packages/core (rules, solver, fairness, acuity, time), the DB repositories, or IPC handlers, and alongside the built-in /code-review.
---

# Scheduling review

This complements `/code-review`. That command finds general correctness bugs; this one checks
invariants specific to nurse scheduling that a generic reviewer cannot know. Run both.

Review the changed code against each section below. A finding is only worth reporting if you can
point at a specific line.

## 1. Time correctness

All schedule arithmetic goes through `packages/core/src/domain/time.ts`. Its header explains why:
contracts are written in **wall-clock** time ("10 hours between shifts"), so the schedule lives on
a continuous local timeline where every day is exactly 1440 minutes. DST does not exist in that
coordinate system.

- No bare `new Date()`, `Date.now()`, `getHours()`, or local-timezone `Date` construction in
  scheduling logic. Real instants (audit timestamps, when a call-off was phoned in) are the only
  legitimate use, and those are typed `Timestamp` in `domain/entities.ts`.
- **Shift duration comes from `ShiftType.durationHours`** (`domain/entities.ts`), never from
  subtracting two timestamps. A subtraction would make one night shift 11 hours and another 13
  across the two DST transitions, silently corrupting rest and consecutive-hours maths.
- **A shift is dated by the day it STARTS.** `shiftWindow(date, timing)` in `time.ts` places it;
  a night shift dated Friday runs into Saturday and is still Friday's night shift. Watch for code
  that re-dates a night shift by its end day, or that groups stretches by anything other than
  start date (see `buildStretches` in `rules/rest-rules.ts`).
- **Windows are half-open `[start, end)`.** `windowsOverlap` in `time.ts` deliberately says a
  shift ending 07:00 does not overlap one starting 07:00. Flag any hand-rolled `<=`/`>=` overlap
  or gap test; use `windowsOverlap` / `restMinutesBetween` instead.
- Weekend membership is configuration, not a Saturday/Sunday test: use `isWeekendWindow` /
  `weekendKey` with the context's `weekendDefinition`, not `isWeekendDate`, for equity counting.

## 2. Rule severity and registration

- A new constraint is a `Rule<P>` (`rules/types.ts`) registered in `ALL_RULES` in
  `rules/registry.ts`. An unregistered rule is invisible to the solver, the grid and the
  compliance report — check the new rule actually appears there.
- Every violation carries a `ViolationCode` from the union in `rules/types.ts`. A new code must be
  added to that union, not stringly typed.
- Build violations with the `violation()` helper in `rules/types.ts` so ids, names and severity
  stay consistent.
- **Violation messages must name the nurse, the dates, and BOTH the actual and the required
  value.** See `minRestRule` in `rules/rest-rules.ts`: "X has only 0 hours off between the Night
  12 on 2026-01-05 and the Day 12 on 2026-01-06. 10 hours required." This text is quoted verbatim
  in union grievances — a message like "rest violation" is a defect, not a nitpick. The same
  numbers belong in `details` for the UI.
- `hard` means illegal (the solver will not emit it); `soft` is advisory. Scoring pressure ("legal
  but unfair") belongs in the objective functions, not as a soft rule. Flag any new rule whose
  severity was chosen to make tests pass.

## 3. Fairness monotonicity

No change may let a strictly worse assignment raise a nurse's fairness score. Concretely: adding a
night, weekend, holiday, on-call, or `avoid_*`-preference shift to a nurse must never move their
burden the favourable way, and a denied request must never score better than an approved one. The
counters live in `FairnessLedgerEntry` in `domain/entities.ts`. Check sign conventions on any new
term, and any normalisation/divisor that could invert at small counts or zero.

## 4. Determinism

A schedule must be reproducible to be defensible — a manager has to be able to regenerate the same
schedule and explain it months later.

- Solver and scoring paths use the seeded RNG. No `Math.random()`, no `Date.now()`, no `new Date()`
  reads on a solve path.
- No reliance on `Object.keys` / `Map` / `Set` iteration order for anything that affects output.
  Sort explicitly by a stable key (ids, `sortOrder`, dates) before iterating. Note `ALL_RULES`
  ordering is presentational only — violations come back in registry order so the report reads
  unsafe-first.
- Tie-breaks must be total: compare on a deterministic field (e.g. `seniorityDate`, then `id`),
  never leaving equal candidates in input order that a Map rebuild could change.

## 5. Audit completeness

- Every mutation writes an `audit_log` entry (`AuditLogEntry` in `domain/entities.ts`,
  append-only, never rewritten). A repository write with no audit write is a finding.
- Denials and overrides must capture a reason: `TimeOffRequest.decisionReason` is required on
  denial, and `AuditLogEntry.reason` carries the manager's justification when they knowingly
  accept a soft violation or override an exchange decision.
- `before`/`after` snapshots should actually be populated on updates, not left undefined.

## 6. Boundary integrity

- `packages/core` imports **nothing** from Electron, `better-sqlite3`, Drizzle, `node:fs`, or
  `node:path`. Grep the diff for those. This boundary is what makes the later web/mobile port a
  re-host rather than a rewrite (see ROADMAP.md, "Architecture").
- The renderer never touches the filesystem or the database directly — everything goes through the
  typed IPC bridge with `contextIsolation` on; the DB is owned by the Electron main process.
- Anything crossing IPC must be plain JSON-serialisable data: no class instances, `Map`, `Set`,
  `Date` objects, or functions in an IPC payload.

## 7. Ratio safety

- Patient-ratio checks stay **hard** constraints. `deriveDemand` in `acuity/demand.ts` computes
  `minCount = max(coverageFloorMin, ratioDerived)` — acuity can only push staffing up, never below
  the contractual floor. Flag any change that lets a ratio or floor be relaxed, skipped, or turned
  into a warning.
- Watch rounding that silently lowers a requirement. `nursesRequiredForMix` in `acuity/demand.ts`
  sums fractional nurse-loads across acuity tiers and rounds up **once**; it also applies
  `roundForFloatSafety` so `6/2` does not become `2.9999999996`. Rounding per tier instead, or
  swapping `Math.ceil` for `Math.round`/`Math.floor`, changes required staffing and is a hard
  finding.
- On-call shifts are standby, not bedside coverage: they contribute no ratio-derived demand and
  are excluded from worked time via `isWorked` in `rules/types.ts`. Check new code keeps that
  distinction.

## Reporting

Report findings grouped by severity, each citing `file:line`:

- **Critical** — produces an illegal or unsafe schedule, or an unreproducible one: ratio/hard-rule
  weakening, DST-unsafe duration maths, non-determinism on a solve path, a missing audit write.
- **Important** — correct today but violates an invariant that will break later: unregistered
  rule, missing `ViolationCode`, a violation message lacking the nurse/dates/actual/required, a
  core→Electron/DB import, non-serialisable IPC payload.
- **Minor** — style and consistency against the patterns above.

State explicitly when a section has no findings, so the reader knows it was checked. If the diff
does not touch an area (e.g. no solver changes), say so rather than inventing findings.
