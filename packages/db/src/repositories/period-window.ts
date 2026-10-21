/**
 * The two numbers that say how far around a period its neighbours are read: the lookback tail
 * and the leave window.
 *
 * Lived in the period loader, which also needs `pay-snapshot.ts` and `holidays.ts`; both of those
 * need these, so the three imported each other and module init order decided whether a constant
 * was defined yet. A leaf that imports no repository breaks the cycle and keeps one definition.
 */

import { addDays, type IsoDate, type SchedulePeriod, type Unit } from '@shiftnurse/core';

/**
 * Days of earlier published shifts a period is judged with (`priorAssignments`, flagged out of
 * period). Rest and stretch rules need only the night before, but a rolling four-weekend quota
 * (`weekend-pattern`'s `maxWeekendsPer4Weeks`) reads the three weekends before the period's first
 * one, which reach up to 22 days back; a 14-day tail let a third weekend in four through unseen.
 * 28 is a whole number of weeks, so it covers that for any start day. Every loader that reads the
 * tail, or what the tail is judged with (leave, sick calls, offers, other units), uses this.
 */
export const PRIOR_ASSIGNMENT_LOOKBACK_DAYS = 28;

/**
 * The dates a period's leave is read over: the lookback tail (as the prior assignments)
 * plus the pay periods and work weeks that touch the period. Contracted-hours and pay-period
 * overtime credit paid leave over a whole pay period, which starts up to payPeriodDays-1 before
 * the period and ends as far after it, and cost prices overtime over the tail's own weeks and
 * pay periods; one pay period (at least a week) either side of the tail covers every one of
 * them. Nothing else (ledger, pending-leave, capacity, conflicts) looks at a request outside
 * the period itself. One definition, so validation, alerts, cost and Generate read the same rows.
 */
export function timeOffWindow(
  unit: Pick<Unit, 'payPeriodDays'>,
  period: Pick<SchedulePeriod, 'startDate' | 'endDate'>,
): { start: IsoDate; end: IsoDate } {
  const slack = Math.max(7, unit.payPeriodDays);
  return {
    start: addDays(period.startDate, -(PRIOR_ASSIGNMENT_LOOKBACK_DAYS + slack)),
    end: addDays(period.endDate, slack),
  };
}
