# core/cost

> Loaded automatically when Claude works on files under this folder. Cross-cutting rules live in the root `CLAUDE.md`. The pay model itself is documented in `types.ts`.

## Conventions

- **A major holiday earns `major_holiday` in place of `holiday`, never both,** and only when the
  unit has a major premium; otherwise it earns the holiday premium as before, so existing units
  price unchanged. `CostContext.majorHolidayDates` carries which dates are major.
- **Publish alerts read `costSchedule` for overtime.** `complianceAlerts` (given `ComplianceInput.cost`)
  groups `AssignmentCost.overtimeHours` by work week or pay period; an unpriced nurse's overtime hours
  are attributed (dollars stay 0) so the alert does not depend on rates having been entered.
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
- **Overtime is paid by the hour, at the highest multiplier any rule gives it.** Every rule makes
  the end of a shift overtime from some hour on (`attributeOvertime` in `cost/cost.ts`); a shift's
  overtime is bands, one `overtime` line each. Daily rules count the workday (shifts by start
  date), `seventh_day` the last day of a work week worked every day. With equal multipliers this
  is the old "larger premium per shift", so existing units price unchanged.
- **A holdover is worked time, and two bases price it by the clock.** `view.paidHours` includes
  `holdoverMinutes`, so daily, weekly and pay-period overtime count it already. `beyond_scheduled_tour`
  starts overtime `thresholdHours` after the *scheduled* end (a grace period; no holdover, none);
  `consecutive` starts it once `thresholdHours` have been on the clock in a `workedStretches`
  stretch, lookback included but never priced. `overtimeStarts` switches exhaustively on `basis` —
  add a basis there, never let it fall through to weekly.
- **Daily premium hours need not count toward weekly overtime.** `OvertimeRule.pyramiding: 'none'`
  (weekly and pay-period rules only; absent is `'stack'`) makes them accrue each shift's straight
  hours — before any non-window basis's overtime starts, lookback shifts' included — because Cal. Lab. Code § 510 and UC–CNA
  Art. 14 §M do not pay an hour twice. `attributeOvertime` therefore prices non-window bases first.
- **A day past the scheduled days is its own basis.** `beyond_scheduled_days` reads
  `Nurse.scheduledDaysPerWeek` (absent: nothing) and makes hours past the threshold overtime on the
  (n+1)th and later worked dates of a work week, lookback counted, never priced (`extraDayTest`):
  a 3×12 nurse's fourth day is double time past 8 (IWC Wage Order 5 § 3(B)(8)).
- **Premiums compound or add, by unit.** `CostContext.premiumStacking: 'additive'` (absent:
  `'compound'`) puts every multiplier and overtime premium on the base rate in `priceView`
  (UC–CNA Art. 14 §N, Title 38); compound is the FLSA regular rate and stays the default.
- **Overtime under a rule's `minimumMinutes` is not paid**, judged per rule per shift in
  `overtimeStarts` (VA: under 15 minutes), never per workday.
- **Day-of pay sits beside the schedule's cost, never in it.** `cost/events.ts`'s
  `priceDayOfEvents` prices missed meal and rest breaks (one hour a day each), reporting-time pay
  (half the shift, 2–4 hours) and call-backs (at least the contract minimum) at the base rate.
  Events are `day_of_pay_event` rows (migration 0025); the call-back minimum is `pay_settings`.
- **A night or evening differential can be earned by the clock.** With a `window` it ignores
  `ShiftType.isNight`: `hoursInDailyWindow` counts the shift's hours inside the daily window (end
  ≤ start wraps midnight). At `wholeShiftAtHours` it is a whole-shift differential like any other;
  below it, only the in-window hours earn it, priced on the base rate and kept out of the running
  rate — 38 U.S.C. §7453 makes night pay and overtime percentages of basic pay, so they never
  stack. An `evening` differential with no window applies to nothing.
- **Overtime rules are scoped by schedule kind.** `OvertimeRule.scheduleKinds` (absent: every
  nurse) is filtered in `attributeOvertime` by `Nurse.scheduleKind ?? 'standard'`, so a VA unit's
  72/80 and Baylor rules sit beside the standard 40-hour week rather than replacing it.
- **A daily rule can judge tour days only, or the other days.** `tourDays` (`tourDayTest`): a tour
  day is a date with a worked tour, lookback included — for a 72/80 nurse a shift whose
  `scheduledHours` is 12, holdover never making one (38 U.S.C. § 7456A(c)(1): past 12 on a tour
  day, past 8 otherwise); for a Baylor nurse a Saturday, a Sunday or a Friday whose shift runs into
  Saturday, pickups included — never `isBaylorTour`, which leaves pickups out — so only a weekday
  is judged past 8 and the weekend by its 24 (§ 7456(b)(3)(A)). Other bases ignore it.
- **The weekend is its own basis.** `weekend` (`weekendOvertime`) sums each shift's hours inside a
  window of `ctx.weekendDefinition` by the clock (`weekendHours`: a Friday 19:00–07:00 gives 7),
  per weekend, and makes those past the threshold overtime, reported at the shift's end like every
  basis's (§ 7456(b)(3)(A): a Baylor nurse past 24 between midnight Friday and midnight Sunday). It
  is a window basis, so it honours `pyramiding` and is priced after the non-window ones; leave does
  not count.
- **A Baylor tour earns no night, evening, weekend or holiday pay.** `isBaylorTour` (exported; the
  tour-plan rule imports it) and § 7456(d): those differentials are withheld from the tour's
  scheduled hours in `priceView`; charge and agency still apply. Only a *regularly scheduled* tour
  (§ 7456(b)(3)(B)): an `isOvertime` pickup is no tour and earns them all. A holdover earns them on its own
  hours, on base and out of `running`; overtime bands are unchanged.
- **A consecutive-shift premium is earned by the run.** `consecutive_shift` with
  `Differential.consecutive` (UC–CNA Art. 14 § I.3; `consecutiveShiftEarners`): a shift counts the
  full shifts (scheduled 12 hours or more) dated on its own day and the `withinDays` days before it,
  so `{4, 4}` pays the fifth of five consecutive 12s. Once that count passes `afterShifts`, it and
  every later shift of the run earn it, even if the count falls back. The run breaks on any
  calendar date with no worked shift (dated by start day); an 8 continues it without counting;
  lookback counts, standby and leave do not. Not § 7453, so a Baylor tour keeps it.
