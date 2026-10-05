# core/cost

> Loaded automatically when Claude works on files under this folder. Cross-cutting rules live in the root `CLAUDE.md`. The pay model itself is documented in `types.ts`.

## Conventions

- **A major holiday earns `major_holiday` in place of `holiday`, never both,** and only when the
  unit has a major premium; otherwise it earns the holiday premium as before, so existing units
  price unchanged. `CostContext.majorHolidayDates` carries which dates are major.
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
- **Day-of pay sits beside the schedule's cost, never in it.** `cost/events.ts`'s
  `priceDayOfEvents` prices missed meal and rest breaks (one hour a day each), reporting-time pay
  (half the shift, 2–4 hours) and call-backs (at least the contract minimum) at the base rate.
  Events are `day_of_pay_event` rows (migration 0025); the call-back minimum is `pay_settings`.
