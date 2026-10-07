/**
 * Two days off together for a nurse who works every weekend of a pay period.
 *
 * VA–NNU Master Agreement Art. 13 §2.D.3: an RN who works every weekend in a pay period gets two
 * consecutive days off in that pay period. A weekend-only pattern otherwise leaves the weekday
 * days off scattered one at a time — never a real break — and nothing else in the rules sees it:
 * the weekend pattern counts weekends, and days off after a stretch need a stretch.
 *
 * A pay period's weekends are the `weekendKey`s of its days, each day taken whole under the
 * unit's weekend window ('overlaps'), so under the default definition Saturday and Sunday both
 * key to the Saturday. A weekend is worked as `nurseWeekends` reads it — any worked (not standby)
 * shift filed under it, last schedule's tail included, so a Saturday worked before the period
 * counts toward a pay period opening on the Sunday. A day off is a date with no worked shift
 * *dated* on it: shifts are dated by their start, as the grid and the unit date them, so the night
 * of Friday does not spoil Saturday as a day off.
 *
 * Known limits: only pay periods lying wholly inside the schedule are judged — one that straddles
 * its end has days this schedule cannot see, so whether they hold the pair is unknown. While soft,
 * Generate does not price it, so it will not steer around a breach; the grid and compliance
 * report flag it. Made hard, `encodeDaysOffTogether` and `SolverModel` forbid it. It is monotone
 * under removal (taking away a weekend shift can only lift the condition, any other shift only
 * adds a day off), which is what `SolverModel.isLegal` relies on when it re-checks a removal.
 */

import {
  addDays,
  compareDates,
  dateInRange,
  datesInRange,
  dayNumber,
  describeDate,
  type IsoDate,
  MINUTES_PER_DAY,
  type WeekendDefinition,
  weekendKey,
} from '../domain/time.js';
import type { ScheduleView } from '../schedule/view.js';
import { type DateWindow, type PayCalendar, payPeriodsIn } from './hours-rules.js';
import { isWorked, nurseName, type Rule, type Violation, violation } from './types.js';
import { nurseWeekends } from './weekend-pattern.js';

export type DaysOffTogetherParams = Record<string, never>;

/** A complete pay period of the schedule and the weekend keys its days fall under. */
export interface PayPeriodWeekends extends DateWindow {
  weekends: IsoDate[];
}

/**
 * The pay periods the rule judges, each with its weekends; shared with the CP-SAT encoder so both
 * read the same calendar. A pay period without a weekend day is left out: it asks nothing.
 */
export function payPeriodWeekends(
  period: DateWindow,
  unit: PayCalendar,
  def: WeekendDefinition,
): PayPeriodWeekends[] {
  const wholeDays: WeekendDefinition = { ...def, mode: 'overlaps' };
  const out: PayPeriodWeekends[] = [];
  for (const window of payPeriodsIn(period, unit, true)) {
    const weekends = new Set<IsoDate>();
    for (const date of datesInRange(window.start, window.end)) {
      const startMinute = dayNumber(date) * MINUTES_PER_DAY;
      const key = weekendKey({ startMinute, endMinute: startMinute + MINUTES_PER_DAY }, wholeDays);
      if (key !== null) weekends.add(key as IsoDate);
    }
    if (weekends.size > 0) out.push({ ...window, weekends: [...weekends] });
  }
  return out;
}

export const daysOffTogetherRule: Rule<DaysOffTogetherParams> = {
  id: 'days-off-together',
  name: 'Two days off together',
  description:
    'A nurse who works every weekend of a pay period gets two days off in a row inside it. A day ' +
    'off is a day with no shift starting on it. Advisory: the grid flags a breach, but Generate ' +
    'only avoids it if you make the rule hard.',
  severity: 'soft',
  category: 'equity',
  scope: 'nurse',
  enabledByDefault: false,
  defaultParams: {},
  paramDocs: {},

  evaluate(schedule: ScheduleView, _params, ctx): Violation[] {
    const payPeriods = payPeriodWeekends(
      { start: schedule.period.startDate, end: schedule.period.endDate },
      ctx.unit,
      ctx.weekendDefinition,
    );
    if (payPeriods.length === 0) return [];
    const violations: Violation[] = [];

    for (const nurse of ctx.nurses) {
      const worked = nurseWeekends(schedule, nurse.id, ctx).worked;
      const shifts = schedule.timelineFor(nurse.id).filter((v) => v.inPeriod && isWorked(v));
      const busy = new Set<IsoDate>(shifts.map((v) => v.assignment.date));

      for (const pp of payPeriods) {
        if (!pp.weekends.every((w) => worked.has(w))) continue;
        let together = false;
        for (let d = pp.start; compareDates(d, pp.end) < 0; d = addDays(d, 1)) {
          if (!busy.has(d) && !busy.has(addDays(d, 1))) {
            together = true;
            break;
          }
        }
        if (together) continue;

        const inPayPeriod = shifts.filter((v) => dateInRange(v.assignment.date, pp.start, pp.end));
        violations.push(
          violation(
            daysOffTogetherRule,
            'soft',
            'no_days_off_together',
            `${nurseName(nurse)} works every weekend of the pay period ` +
              `${describeDate(pp.start)} – ${describeDate(pp.end, { year: true })} and has no ` +
              'two days off together in it.',
            {
              nurseIds: [nurse.id],
              dates: inPayPeriod.map((v) => v.assignment.date),
              assignmentIds: inPayPeriod.map((v) => v.assignment.id),
              details: {
                payPeriodStart: pp.start,
                payPeriodEnd: pp.end,
                weekends: pp.weekends.length,
              },
            },
          ),
        );
      }
    }
    return violations;
  },
};
