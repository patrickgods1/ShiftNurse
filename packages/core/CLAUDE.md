# packages/core

> Loaded automatically when Claude works on files under this folder. Cross-cutting rules live in the root `CLAUDE.md`. Solver internals: `src/solver/CLAUDE.md`; pricing: `src/cost/CLAUDE.md`.

## What is here

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

## Domain conventions

- Rules are data plus a small evaluator in `rules/registry.ts`. A new contract clause is a new
  `Rule` plus a registry entry — the solver, grid and compliance report pick it up for free.
- **A shift's broken preferences reach the grid.** `fairness/ledger.ts`'s `preferencesBroken`
  is the one definition (`isUndesirable` is its yes/no, which the ledger and digest count);
  `schedule.validate` returns `againstPreference` per assignment and the grid marks those chips.
- **Fairness fair-share is pinned to `contractedHoursPerPeriod`, never worked hours.** That is
  what makes the score monotone (an extra night can never raise it); basing shares on hours
  actually worked would let a nurse who works only nights "improve" by taking one more. Only
  a shift that honours none of a nurse's preferences is unambiguously worse — a day shift for
  a nurse avoiding nights raises their hit rate — so the property test excludes such pairs.
- **A finding keeps the severity its rule gave it** unless the rule set overrides the rule
  (`PreparedRule.override`): `fte-target-hours` refuses hours past the contract (hard) but only
  advises on a shortfall (soft) — being short is a manager's decision, not a breach — and a
  contract that guarantees full hours sets the rule hard, which makes both hard.
- **Days off after nights** (`rules/night-recovery.ts`, soft, nurse scope): a day or evening
  shift within `daysOffAfterNights` (2) days of a night is flagged once, against the last night,
  lookback nights included. Both solvers price it per such shift at `nightRecovery` (45, in the
  preferences bucket): `SolverModel.recoveryFor` and CP-SAT's `nightRecoveryTerms`; hard, it is
  `encodeNightRecovery`'s forbidden pairs. Rest hours alone allowed Night, Day, Night in four days.
- **Time off is decided before the schedule, and late requests are covered, not regenerated.**
  `rules/pending-time-off.ts` (soft, nurse scope) flags a shift inside a request still pending;
  both solvers price it per shift at `pendingTimeOff` (80, preferences bucket; `SolverModel.
  pendingPenaltyOf`, CP-SAT `perShiftTerms`; hard: `encodePendingTimeOff`), so Generate keeps
  asked-for days free when it can. A request is judged by `conflicts/capacity.ts`'s
  `leaveCapacity` — per day and role, shifts the floors need against what contracted staff not on
  leave supply at their contracted hours, plus per diem — never by the draft (`TimeOffImpact.
  capacity`). It judges against the unit's *usual* day, not a perfect one: "tight" only when leave
  adds a whole shift to the usual per-diem gap, or a unit built to lean on per diem (the community
  demo) reads every request on every day as tight. `main/api/leave.ts` is the late path: `coverOptions` ranks legal cover for each
  freed shift (the day-of `findReplacements`, with the leave approved) and `approveAndCover`
  approves, takes the shifts off (a published period's too, under a reason, in the change log)
  and writes the chosen cover in one transaction, re-checking every pick first. A period's
  optional `requestsCloseOn` (migration 0014) marks later requests as late; it never refuses one.
- **Every rule declares a `scope`** (`'nurse'` or `'shift'`). The solver evaluates hard rules
  incrementally on a view holding one nurse's timeline or one shift's roster, so a rule that
  secretly reads more than its scope passes in the solver and fails on the grid. Nurse-scope hard
  rules gate every addition (except `under_contracted_hours`, a floor the objective pushes toward);
  shift-scope hard rules are priced, and what remains is the report's `unfilled` list.
- **Every registered rule needs a CP-SAT encoding.** `CPSAT_ENCODERS` in `solver/cpsat/encode.ts`
  maps each rule id to an encoder or `'by-construction'`; a test fails on any missing id, and
  `encodeCpsat` refuses by name when an enabled hard rule has none. A new rule is therefore a
  `Rule`, a registry entry *and* an encoder, checked against the rule engine by
  `encode.test.ts` (hand-worked cases, parity with `SolverModel`, and 400 random rosters that
  must be judged identically). CP-SAT's answers still go back through `SolverModel.canAdd`
  before anything is written — the rule engine stays the judge.
- **`dayNumber`/`fromDayNumber` are memoised.** The rule engine on partial views converts the same
  few dozen dates millions of times per solve; without the cache that was 60% of a run.
  `compareDates`, `minDate`, `maxDate` and `dateInRange` compare the ISO strings directly
  (validated `YYYY-MM-DD` sorts in calendar order): `compareDates` returns only a sign — use
  `daysBetween` for a distance. `ScheduleView.dates` is a shared, frozen array; its other indexes
  are built on first use.
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
- **Accommodations are absolute, and judged by the hour.** An `AvailabilityBlock` (a recurring
  weekday window, optional dates, `rules/availability-blocks.ts`) bars any shift whose wall-clock
  window overlaps one of its occurrences — unlike leave, which removes shifts *dated* in it — so a
  Friday 18:00 to Saturday 18:00 Sabbath bars a Friday day shift to 19:00 and a Saturday morning.
  An occurrence is placed from its own date (end at or before start runs past midnight; equal
  times are 24 hours) and checked against shifts dated the day before, the day and the day after.
  `blockedAt` is shared by the rule (`accommodation-blocks`, hard) and `encodeAccommodationBlocks`.
  The reason is HR/medical: never in a violation message, and the audit entries stay out of a
  nurse's exported record.
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
  twice). `rules/paid-leave.ts` turns both into dated credits in `RuleContext.paidLeaveByNurse`,
  a request's paid hours cut into **whole shifts** of the unit's worked lengths and spaced over
  its days — never spread by the hour: 36h over a week that crossed a pay period read as 5.1h and
  30.9h, targets no run of 12s can meet, so an approved week off left the nurse "short";
  the contracted-hours rule adds them (`paidLeaveCountsTowardHours`, on), the max-hours rule adds
  them to the overtime threshold only when `paidLeaveCountsTowardOvertime` is on (off: federal
  wage-and-hour law does not treat leave as hours worked) and never to the absolute weekly cap.
  Every consumer reads the same credit: `SolverModel` takes it off `hoursTarget` and adds it to
  `weekLeaveHours`, the CP-SAT caps subtract it (rounded down to integer hundredths), the cost
  engine starts a week's overtime count with it via `CostContext.overtimeLeaveHours`, and
  compliance alerts count it. `SolveInput.paidSickCalls` comes from `loadPeriodInput`.
- **Every rule parameter is documented on the rule.** `Rule.paramDocs` (label, hint, why, and
  `input`/`optional`/`min`/`activeWhen` for the editor) is typed to cover every key of `P`, and
  Settings › Rules builds its form from it; `param-docs.test.ts` fails on a gap. A new rule's
  parameters are not done until a manager can read what they do. Help in the renderer follows
  `components/field-help.tsx`: a visible hint for what a setting does, an ⓘ tip for why to change
  it, the tip never inside the `<label>`.
- **Holidays rotate by name, year to year.** `rules/holiday-rotation.ts` (soft, nurse scope):
  a nurse who worked last year's occurrence — same name, 300–430 days earlier — is owed this
  year's off; with `pairMinorWithMajor`, a minor holiday's `pairedHolidayId` major (any major, any
  distance — the manager's choice) keeps one nurse off both. A pair is judged by the period that
  holds its later half, reading the earlier half from history; `holidayWorkForPeriod` loads the
  far half's record however long ago it was. "Who worked" is `HolidayWorkRecord`s from `holidayWorkForPeriod` (published
  schedules, or the hand-recorded `holiday_work` list once `holiday.work_recorded` is set, which
  is authoritative even empty). Both solvers price breaches from `SolverModel.holidayFacts` at
  `holidayRotation` (in the fairness bucket); hard, the gate and `encodeHolidayRotation` forbid
  them. A shift dated on the holiday counts, standby does not — as for pay and the ledger.
  Names are matched by `holidayNameKey` (case, spacing and punctuation ignored), and a year is
  added by rolling the last forward — `setup/holiday-year.ts`'s `planHolidayYear` (federal names
  take their new date, others keep month and day; pairings carried, a cross-year pair re-linked
  as `repairs` once its partner's year is added), saved by `addHolidayYear` in one transaction —
  so names and pairings stay the same year to year instead of being re-typed.
- **CSV exports defuse formulas.** `serializeCsv` prefixes `'` to a field starting `=`, `+`, `-`,
  `@`, tab or CR (numbers exempt) and `parseCsv` removes it, so an exported roster opened in
  Excel cannot run a formula hidden in a name, and still re-imports as itself.
- **HPPD and acuity care hours are advisory.** `ShiftDemand.careHoursRecommendedNurses` (care hours
  ÷ shift length) and `hppdRecommendedNurses` show on the Demand page; `acuity/hppd.ts`'s
  `scheduledHppd` compares a period's scheduled hours per patient day with the target on the Demand
  page and Dashboard. Neither changes a minimum, and Generate reads neither.
- **A ratio holds at all times, so its count is more than the bedside.** `Unit.ratioStaffing`
  (migration 0015; absent or the column defaults = the old reading) says whether the charge nurse
  takes patients and how many break minutes each bedside nurse takes. `deriveDemand` is the one
  place it applies: `ratioDerived = ratioBedside + chargeWithoutPatients + breakRelief`, the charge
  nurse added only to a standalone RN shift, relief `ceil(bedside × minutes ÷ (shift − 120 min))`,
  one fewer when a charge nurse free of patients covers breaks. The ratio rule, both solvers,
  day-of and conflicts read `ratioDerived`/`minCount` and follow; the breach divides patients by
  the nurses at the bedside.
- **A rule a unit opts into ships off.** `Rule.enabledByDefault: false` keeps it disabled in
  `defaultRuleSet` and in a stored rule set saved before it shipped (`resolveConfigs`), so adding
  one never changes an existing unit. `no-mandatory-overtime` and `weekend-pattern` are such.
- **No mandatory overtime is judged against offers, not flags.** `isOvertime` says overtime is
  authorised; `no-mandatory-overtime` (hard, off by default) also wants an `OvertimeVolunteer`
  offer covering the date or notes beginning `Emergency:`. Neither solver writes an overtime row,
  so CP-SAT meets it by construction; day-of calls volunteers first within the overtime tier.
- **Weekends are filed by `weekendKey`, everywhere.** Fairness, `weekend-pattern` and both
  solvers' prices use it; under `'overlaps'` a Friday night belongs to the weekend it runs into.
  `weekendBreaches` is the one count (`SolverModel.weekendFor`, CP-SAT `weekendBreachExprs`).
- **A credential is valid through its expiry date.** `credentialLapsedOn` is the one definition,
  for the rules, the publish alerts and the Dashboard's lapsed list.
- **State presets only tighten.** `JURISDICTION_PRESETS` cites the provision behind every value
  (checked against the statute text, October 2026) and says what it leaves to the hospital;
  `planJurisdiction` lowers looser ratio ceilings, grows break minutes, adds missing overtime
  rules and switches rules on, never the reverse, and plans nothing on a second run. A change to
  a law is a change to its preset, its citation and its summary together.
- **Leave bids are awarded in seniority order, one a nurse a pass.** `leave/bidding.ts`'s
  `awardBids` is pure and deterministic (seniority date, then employee number); leave already
  approved takes its places first; every choice not awarded carries a quotable reason naming the
  full days and who holds them, labelled by how (an award, or leave approved before the round).
  `awardRound` (ShiftNurseTx) turns awards into approved PTO through the ordinary approval, with
  `suggestedPaidLeaveHours`, and records each denial with `recordAuditStrict`.
- **A licensed ratio pools RNs and LVNs, and counts the RN share once.** `RatioRule.role` may be
  `'licensed'` with `minRnShare` (migration 0020); `ShiftDemand.licensed` holds the pool. Every RN
  the share needs counts toward the pool too, so the pool is short only beyond them —
  `short − min(short, rnShort)` — in the ratio rule, both solvers, `SolverModel.hardShortfall`,
  the conflicts engine (`fillsRatioRole`; a `licensed` slot) and Today. The search aims at a short
  pool through `SolverModel.shortRoles` (LPN first). A census cancellation shares the pool's
  slack between RNs and LVNs (`overstaffedRoles`), LVNs first.
- **Sending staff home follows the unit's cancellation order.** `dayof/cancellation.ts`'s
  `cancellationOrder` ranks volunteers, agency, overtime, per diem, then a rotation (fewest
  cancellations, longest ago, most junior); the charge nurse is never cancelled. Main cancels only
  the next in order, and the removal is logged under the change source `'census'`.
- **Floating a nurse out follows the contract's order.** `dayof/float-order.ts`'s `floatOrder` ranks
  volunteers (in the order offered), then a rotation (fewest *mandated* floats in the last year,
  longest ago, most junior); the charge nurse, a nurse not float-eligible and an orientee are never
  floated. A volunteered float does not count against the rotation. An objection is recorded on the
  `FloatRecord` and never bars the float. Main floats only the first, logged under source `'float'`.
- **Another unit's shifts are busy time, not this unit's.** `schedule/elsewhere.ts`'s
  `busyElsewhere` copies the other unit's shift types as inactive `elsewhere:<id>` types and its
  shifts as locked rows in `priorAssignments`, so every nurse rule judges them and nothing staffs,
  flags or prices them here. `loadPeriodInput` and the grid's validation read them from other
  units' draft and published periods. Float members (`nurse_unit`, migration 0024) join the
  roster *after* the home nurses — order is behaviour — with their own leave, credentials and
  preferences (`rosterForPeriod`, `floatExtras`).
- **An orientee works with their preceptor.** `rules/preceptor.ts` (`orientee-with-preceptor`,
  hard, shift scope, on by default and silent without preceptorships) counts a preceptor on the
  shift or on the one it runs inside; standby is not judged. CP-SAT prices it at `hardShortfall`
  (`encodePreceptor`).
- **A rest waiver excuses one turnaround, keyed on the later shift.** A `RestWaiver` (nurse, date,
  reason, `recordAuditStrict`) lets `min-rest-between-shifts` pass a short rest only when the shift
  *after* it starts on the waiver's date; `restWaivedOn` is shared by the rule and `encodeRest`,
  which must skip the pair too or a locked turnaround makes CP-SAT infeasible (VA–NNU Art. 13 §2).
- **Tours are named by when a shift starts.** `rules/tour-rotation.ts`'s `tourOf`: 04:00–11:59 day,
  12:00–17:59 evening, otherwise night — never `isNight`, a pay flag a Title 38 evening tour also
  carries. `tour-rotation` (soft, off by default) caps distinct tours per schedule, wants
  `minHoursBetweenTours` between shifts on different tours, and keeps a nurse with a
  `permanentTour` on it. Monotone under removal, so the gate is the generic nurse-scope one;
  `encodeTourRotation` enforces it when hard (locked breaches stand, `atMost` stops them growing).
  Neither solver prices it while soft — a stated limit.
- **Overtime by the contract's rosters is a unit's choice.** `Unit.overtimeOrder: 'roster'` reorders
  only the overtime tier of `findReplacements`: volunteers longest since their last overtime
  (`lastOvertimeOn`, from `lastOvertimeDates`), then seniority; then the mandated roster most junior
  first (VA–NNU Art. 14). Absent or `'cost'` keeps volunteers, cost, burden, recency.
- **A per-diem commitment is an alert, not a rule.** `complianceAlerts`' `per_diem_commitment`:
  weekend shifts per four weeks scaled up to the period (`ceil`), and holidays per calendar year
  judged only by the period holding the year's last holiday, counting earlier ones from history.
  A floor made hard would gate every shift added to an under-committed nurse.
- **Holiday priority is advice.** `leave/holiday-priority.ts` ranks pending requests for the same
  holiday: worked last year's occurrence (`previousOccurrence`) first, then seniority (VA–NNU
  Art. 10; peer agreement is the manager's decision). It approves nothing.
- **A posted shift changes with the nurse's consent when the unit says so.**
  `Unit.requireConsentForPostedChanges` makes `requireChangeConsent` refuse a `'manual'` edit to a
  published period without a consent note, stored on `schedule_change.consent` and in the audit
  reason. Trades, leave, call-ins, census cancellations and floats are exempt: the nurse asked, or
  the contract's order decided.
- **Leave balances and FMLA warn, never block.** `leave/balances.ts`: `checkLeaveBalance`.
  `leave/accrual.ts`: `projectBalance` carries payroll's figure forward to a date — accrual on
  each closed pay period's last day by the nurse's `AccrualRule` (first match wins; tiers by
  years since `hireDate ?? seniorityDate`), a balance cap, approved use, and the carryover cap
  forfeiting the excess at each leave-year start (federal: the first full pay period of January).
  Same-day order is forfeit, accrue, use. `leave/fmla.ts` is regime-aware: Title I (29 C.F.R.
  § 825) has the 1,250-hour test, 12 × the usual (or 52-week average) week, and the unit's
  choice of the four 12-month methods; Title 5 (5 C.F.R. § 630.1203, VA staff) has no hours test,
  6 × the biweekly tour, and a period always measured forward from first use. Periods are
  inclusive; rolling back is the 365 days ending on the date. `leave/policy.ts` validates a
  unit's `LeavePolicy`; absent, a unit runs `DEFAULT_LEAVE_POLICY` (Title I, rolling back, no
  accrual).
