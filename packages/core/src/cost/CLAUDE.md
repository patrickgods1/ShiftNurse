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
  params, so a shift is not flagged as overtime by the rules and priced as straight time.
  A `pay_period` overtime rule (8/80-style) prices per nurse-pay-period instead; the max-hours
  rule's `overtimeByPayPeriod` is its rule-engine twin, honoured by `SolverModel.eligible`, the
  CP-SAT encoder, compliance alerts and the exchange evaluator alike. The weekly cap
  (`maxHoursPerWeek`) binds every week either way. The DB's `effectiveRateForNurse` delegates to core's `resolvePayRate`; do not add a second
  definition of "the rate in force".
- **Overtime is paid by the hour, at the highest multiplier any rule gives it.** Every rule makes
  spans of a shift overtime, usually its end from some hour on (`attributeOvertime` in
  `cost/cost.ts`); a shift's overtime is bands, each with its own `from`, one `overtime` line
  each. Daily rules count the workday (shifts by start date), `seventh_day` the last day of a work
  week worked every day. With equal multipliers this
  is the old "larger premium per shift", so existing units price unchanged.
- **A holdover is worked time, and two bases price it by the clock.** `view.paidHours` includes
  `holdoverMinutes`, so daily, weekly and pay-period overtime count it already. `beyond_scheduled_tour`
  starts overtime `thresholdHours` after the *scheduled* end (a grace period; no holdover, none);
  `consecutive` starts it once `thresholdHours` have been on the clock in a `workedStretches`
  stretch, lookback included but never priced. `overtimeStarts` switches exhaustively on `basis` —
  add a basis there, never let it fall through to weekly.
- **Daily premium hours need not count toward weekly overtime.** `OvertimeRule.pyramiding: 'none'`
  (window rules only; absent is `'none'` when any daily-style rule (a non-window basis) applies to
  the nurse, else `'stack'` (D16; 29 CFR 778.202(c))) makes them accrue each shift's straight
  hours — before any non-window basis's overtime starts, lookback shifts' included — because Cal. Lab. Code § 510 and UC–CNA
  Art. 14 § L.2.c.1 do not pay an hour twice. `attributeOvertime` therefore prices non-window bases first.
- **A day past the scheduled days is its own basis.** `beyond_scheduled_days` reads
  `Nurse.scheduledDaysPerWeek` (absent: nothing) and makes hours past the threshold overtime on the
  (n+1)th and later worked dates of a work week, lookback counted, never priced (`extraDayTest`):
  a 3×12 nurse's fourth day is double time past 8 (IWC Wage Order 5 § 3(B)(8)).
- **Premiums compound or add, by unit.** `CostContext.premiumStacking: 'additive'` (absent:
  `'compound'`) puts every multiplier and overtime premium on the base rate (UC–CNA Art. 14 § M,
  Title 38); compound is the FLSA regular rate and stays the default. Under compound the overtime
  premium is `(multiplier − 1) ×` the regular rate of the work week, or of the pay period for a
  nurse whose rules hold a `pay_period` rule and no `weekly` one (D16; 29 CFR 778.109, 778.115,
  778.601(e)): every straight dollar of the window, lookback tail included, over its hours worked,
  a week-crossing shift apportioned by T06's split point. `costTimeline` prices straight time
  first (`priceStraight`), then the bands (`addOvertime`).
- **The premium is order-invariant** (`overtime.property.test.ts`): it depends on the window's
  regular rate, not on which shift carries the band.
- **Holiday pay can cover holiday overtime.** `CostContext.holidayPayCoversOvertime` (absent:
  false) withholds the overtime premium from exactly the hours paid holiday pay (38 U.S.C.
  § 7453(g): no overtime "in addition to" (d) pay): every hour of a shift that earns `holiday` or
  `major_holiday`, but on a Baylor tour only its held hours, since § 7456(d) pays the tour itself
  none — `addOvertime` compares each band's `[from, from + minutes)` with the scheduled minutes.
  `overtimeHours` still counts every hour for alerts and the ledger.
  `PaySettings`/`DEFAULT_PAY_SETTINGS` in `types.ts` are the shape presets propose.
- **Holiday follows the unit's `holidayAttribution`** (D18; absent: the start date, the fairness
  convention; `'clock'` pays the hours on the holiday; `'majority'` the whole shift by where most
  of it falls), the same definition the ledger, the rotation and both solvers use
  (`schedule/holiday-attribution.ts`). By the clock the premium is a partial line per holiday
  date (`clockHolidayMinutes`), major or ordinary per date, and `holidayPayCoversOvertime` covers
  only the band minutes on the holiday (`StraightPay.covered`).
- **Weekly and pay-period overtime split a shift at the window edge by the clock** (D17, 29 CFR
  778.104), unless `PaySettings.overtimeWindowAttribution` is `'start'`. So the first hours of a
  Saturday night can be overtime and its Sunday hours straight; bands carry their own start. The
  split point (`realOffset`, `minutesBeforeEdge`, `splitMinutes`) lives in `schedule/window-split.ts`,
  which the `max-hours-per-week` rule and both solvers share, so they count the hours pay counts.
  The edge is `CostContext.workWeekStartMinute` after midnight on the window's first date (absent:
  0; the rule's `workWeekStartMinute`, 29 CFR 778.105, 778.601(b)): weekly and pay-period
  windows file a shift by the window-day of its start (`windowDayOf`) and split at that wall
  minute, as do the regular-rate windows; daily, seventh-day and extra-day bases keep the
  calendar day: `extraDayTest` and `seventhDayTest` read `workWeekStartsOn` by date and do not
  follow `workWeekStartMinute`. The week is the nurse's own (`workWeekFor`): with
  `CostContext.nightWorkWeekStartsOn` set, a nurse on permanent nights has her weekly overtime and
  her regular-rate weeks on the night week, and her pay periods start at
  `nightWorkWeekStartMinute` on the usual dates; `extraDayTest` and `seventhDayTest` stay on the
  unit's week.
- **The DST nights are paid as worked.** `CostContext.dstTransitions` (host-supplied) makes the
  fall-back night 13 hours and the spring one 11 for every hour count in pay; tour, full-shift and
  Baylor classification still read declared hours. `CostContext.paySpringForwardAsScheduled`
  (`PaySettings`, default false) pays only the spring night's straight lines (base and
  differentials) on `max(real, workedHours × 60)` minutes in `priceStraight`; the regular rate's
  minutes and overtime attribution keep `paidMinutesOf`, so overtime hours and the caps never move.
- **Minutes and cents.** Overtime is attributed in whole minutes; every line amount is rounded to
  the cent (`cost/money.ts`) and totals add cents, so an exactly-40-hour week has no overtime line
  and a total is the sum of its lines.
- **Overtime under a rule's `minimumMinutes` is not paid**, judged per rule per shift in
  `overtimeStarts` (VA: under 15 minutes), never per workday.
- **Day-of pay sits beside the schedule's cost, never in it.** `cost/events.ts`'s
  `priceDayOfEvents` prices missed meal and rest breaks (one hour a day each), reporting-time pay
  (half the shift, 2–4 hours) and call-backs (at least the contract minimum) at the base rate.
  A break premium under `breakPremiumRate: 'regular'` (`PaySettings`; the California preset's,
  Lab. Code § 226.7, *Ferra*) is paid at `DayOfPayPolicy.regularRateFor`, which main builds from
  `AssignmentCost.regularRate` (the regular rate of the window the shift's *start* lies in, from
  the sums under either stacking, though additive overtime is paid on base): the shifts dated that day, the highest if they differ,
  none meaning base. `NurseCost.regularRates` lists every window an in-period shift touches, under
  either stacking; the setting also prices the lookback tail.
  Events are `day_of_pay_event` rows (migration 0025); the call-back minimum is `pay_settings`.
  Reporting-time pay is booked only for a cancellation recorded after the start or within
  `reportingPayNoticeHours` of it (default 2, D13): `reportingPayOwed` decides, main asks.
  A nurse the caller did not pass is an error, never "unpriced"; main passes every nurse an event names.
- **A night or evening differential can be earned by the clock.** With a `window` it ignores
  `ShiftType.isNight`: `hoursInDailyWindow` counts the shift's hours inside the daily window (end
  ≤ start wraps midnight). At `wholeShiftAtHours` it is a whole-shift differential like any other;
  below it, only the in-window hours earn it, priced on the base rate and kept out of the shift's
  running rate. Under compound stacking those dollars are in the week's regular rate, so they
  raise the overtime premium (29 CFR 778.207(b)); under additive they do not, since 38 U.S.C.
  § 7453 makes night pay and overtime percentages of basic pay. An `evening` differential with
  no window applies to nothing.
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
  scheduled hours in `priceStraight`; charge and agency still apply. Only a *regularly scheduled* tour
  (§ 7456(b)(3)(B)): an `isOvertime` pickup is no tour and earns them all. A holdover earns them on its own
  hours, on base and out of `running`; overtime bands are unchanged.
- **A consecutive-shift premium is earned by the run.** `consecutive_shift` with
  `Differential.consecutive` (UC–CNA Art. 14 § G.3; `consecutiveShiftEarners`): a shift counts the
  full shifts (scheduled 12 hours or more) dated on its own day and the `withinDays` days before it,
  so `{4, 4}` pays the fifth of five consecutive 12s. Once that count passes `afterShifts`, it and
  every later shift of the run earn it, even if the count falls back. The run breaks on any
  calendar date with no worked shift (dated by start day); an 8 continues it without counting;
  lookback counts, standby and leave do not. Not § 7453, so a Baylor tour keeps it.
  `consecutive.tiers` (2025–2030 § G.3: {8: 6/6}, {10: 5/5}, {12: 4/4}) replace that one reading:
  each tier counts shifts scheduled for at least its `fullShiftHours` over its own window, and the
  run crosses once any tier does; still one differential and one multiplier. Absent tiers is the
  12-hour tier from the top-level numbers, so existing units price unchanged.
- **A short-rest premium is earned by the gap before a shift.** `short_rest` with
  `Differential.shortRest` (UC–CNA 2025–2030 § N.1, WSNA § 7.10; `shortRestCutoffs`): a worked shift
  starting less than `minHoursOff` after the end of the latest worked shift before it
  (`latestEndingBefore`, as the rest rule measures; holdover in, lookback counted) earns it.
  Standby and call-backs are not that work period (§ N.3; call-backs never reach cost), leave is no
  shift, and a rest waiver does not remove it. `'whole_shift'` is a whole-shift differential;
  `'within_window'` pays only the real minutes before end + `minHoursOff`, a line priced like a
  holiday by the clock (running rate under compound, base under additive, out of `running`).
- **Only one active differential per kind: the repository refuses a second (M-84), because
  `differentialOf` pays the first. A multiplier is at least 1** — except on-call standby, paid
  instead of base at `base × amount`, where only a negative multiplier is refused (the VA's 0.15).
