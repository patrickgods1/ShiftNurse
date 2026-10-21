/**
 * Complete weekends: a weekend a nurse works at all, she works whole.
 *
 * INRC-II's "complete weekends" pattern term (owner decision L-35). A nurse given only the
 * Saturday has lost the weekend for one shift: she cannot go away, and the day off beside it is a
 * weekday's rest, not a weekend's. `weekend-pattern` counts weekends worked and cannot see this —
 * half a weekend and a whole one are the same weekend to it — so without this rule Generate would
 * happily spread weekend shifts one day each across the team and call the result fair.
 *
 * A weekend is the unit's (`weekendKey`): it is worked when any worked shift is filed under it,
 * and its days are the calendar dates lying whole inside its window (Sat and Sun under the
 * default). A day is worked when a worked shift is *dated* on it, by its start, as leave and days
 * off read it — so under `'overlaps'` a Friday night works the weekend but neither of its days.
 * Standby is not work, and another unit's shift is that unit's weekend, not this one's. A weekend
 * is judged only when this schedule works it (history cannot be fixed), reads its earlier days
 * from the lookback tail, and is left to the next schedule when any of its days runs past this
 * one's last. With `RuleContext.historyFrom` set, a weekend whose first day falls before the
 * schedule and before the complete history is not judged: a gap in the tail looks exactly like a
 * day off (`schedule/history.ts`), and the Saturday may well have been worked. Without it the tail
 * is read as it stands, as the other rules do. A Baylor nurse is not judged (`judgesWeekends`): her weekends are the plan.
 *
 * Soft and off by default, so no existing unit changes. While soft, both solvers price each
 * finding (`completeWeekend`, fairness bucket: `SolverModel.completeWeekendFor` counts them with
 * `completeWeekendFindings`, CP-SAT with `completeWeekendTerms`); hard, `encodeCompleteWeekends`
 * forbids it. Not monotone under removal — taking the Sunday away from a whole weekend breaks it
 * — so `SolverModel.isLegal`'s re-check after a removal is what holds the gate.
 */

import type { Nurse } from '../domain/entities.js';
import {
  compareDates,
  dayNumber,
  describeDate,
  fromDayNumber,
  type IsoDate,
  MINUTES_PER_DAY,
  type WeekendDefinition,
  weekendKey,
} from '../domain/time.js';
import { isElsewhere } from '../schedule/elsewhere.js';
import type { AssignmentView, ScheduleView } from '../schedule/view.js';
import { isWorked, nurseName, type Rule, type Violation, violation } from './types.js';
import { judgesWeekends } from './weekend-pattern.js';

export type CompleteWeekendsParams = Record<string, never>;

/**
 * The calendar dates lying whole (00:00–24:00) inside the window of the weekend `key` names.
 * `weekendKey` names a weekend by the day its window opens, so the window starts that day at the
 * definition's start minute.
 */
export function weekendDates(key: IsoDate, def: WeekendDefinition): IsoDate[] {
  const start = dayNumber(key) * MINUTES_PER_DAY + (def.startMinute % MINUTES_PER_DAY);
  const end = start + def.durationMinutes;
  const dates: IsoDate[] = [];
  for (let day = Math.ceil(start / MINUTES_PER_DAY); (day + 1) * MINUTES_PER_DAY <= end; day++) {
    dates.push(fromDayNumber(day));
  }
  return dates;
}

/** A shift that works a weekend or a day of it here: not standby, not another unit's. */
export function worksWeekendHere(view: Pick<AssignmentView, 'shiftType'>): boolean {
  return !view.shiftType.isOnCall && !isElsewhere(view.shiftType);
}

/** The schedule a weekend is judged in, and how far back its published tail is complete. */
export interface WeekendSpan {
  start: IsoDate;
  end: IsoDate;
  /** `RuleContext.historyFrom`: absent when nobody has said the tail is complete. */
  historyFrom: IsoDate | undefined;
}

/**
 * The weekends one nurse is judged on, with their days: every weekend a worked in-period shift of
 * hers is filed under, none of whose days runs past the schedule's end, and none of whose days
 * before the schedule lies before the complete history. Shared by the rule, `SolverModel` and the
 * CP-SAT encoders, so the three judge the same weekends.
 */
export function judgedWeekends(
  timeline: readonly Pick<AssignmentView, 'shiftType' | 'window' | 'inPeriod'>[],
  def: WeekendDefinition,
  span: WeekendSpan,
): { weekend: IsoDate; dates: IsoDate[] }[] {
  const keys = new Set<IsoDate>();
  for (const v of timeline) {
    if (!v.inPeriod || !worksWeekendHere(v)) continue;
    const key = weekendKey(v.window, def) as IsoDate | null;
    if (key !== null) keys.add(key);
  }
  const out: { weekend: IsoDate; dates: IsoDate[] }[] = [];
  for (const weekend of [...keys].sort(compareDates)) {
    const dates = weekendDates(weekend, def);
    if (dates.length === 0 || compareDates(dates[dates.length - 1]!, span.end) > 0) continue;
    const first = dates[0]!;
    if (
      span.historyFrom !== undefined &&
      compareDates(first, span.start) < 0 &&
      compareDates(first, span.historyFrom) < 0
    ) {
      continue;
    }
    out.push({ weekend, dates });
  }
  return out;
}

/**
 * One nurse's findings from her timeline (lookback tail and other units' shifts may be on it; they
 * are filtered here). The rule reports them and `SolverModel` counts them while the rule is soft,
 * so the grid and Generate cannot disagree about how many there are.
 */
export function completeWeekendFindings(
  timeline: readonly AssignmentView[],
  nurse: Nurse,
  def: WeekendDefinition,
  span: WeekendSpan,
): Violation[] {
  if (!judgesWeekends(nurse)) return [];
  const here = timeline.filter(worksWeekendHere);
  const violations: Violation[] = [];
  const worked = new Set<IsoDate>(here.map((v) => v.assignment.date));

  for (const { weekend, dates } of judgedWeekends(here, def, span)) {
    const unworked = dates.filter((d) => !worked.has(d));
    if (unworked.length === 0) continue;
    // Every in-period shift filed under the weekend: taking each away is what clears it.
    const shifts = here.filter((v) => v.inPeriod && weekendKey(v.window, def) === weekend);
    const first = dates[0]!;
    const last = dates[dates.length - 1]!;
    const workedDays = dates.length - unworked.length;
    violations.push(
      violation(
        completeWeekendsRule,
        'soft',
        'split_weekend',
        `${nurseName(nurse)} works the weekend of ${describeDate(first)} – ` +
          `${describeDate(last, { year: true })} only in part: no shift starts on ` +
          `${unworked.map((d) => describeDate(d)).join(' or ')}, so ${workedDays} of its ` +
          `${dates.length} days ${workedDays === 1 ? 'is' : 'are'} worked. A weekend worked ` +
          'should be worked whole.',
        {
          amount: unworked.length,
          nurseIds: [nurse.id],
          dates: shifts.map((v) => v.assignment.date),
          assignmentIds: shifts.map((v) => v.assignment.id),
          details: { weekend, weekendDates: dates, unworkedDates: unworked },
        },
      ),
    );
  }
  return violations;
}

export const completeWeekendsRule: Rule<CompleteWeekendsParams> = {
  id: 'complete-weekends',
  name: 'Complete weekends',
  description:
    'A nurse who works a weekend works all of it: given only the Saturday, she has lost the ' +
    'weekend for one shift. A day counts as worked when a shift starts on it. Weekends running ' +
    'past the schedule’s last day are left to the next schedule.',
  severity: 'soft',
  category: 'equity',
  scope: 'nurse',
  enabledByDefault: false,
  defaultParams: {},
  paramDocs: {},

  evaluate(schedule: ScheduleView, _params, ctx): Violation[] {
    return ctx.nurses.flatMap((nurse) =>
      completeWeekendFindings(
        schedule.timelineFor(nurse.id).filter(isWorked),
        nurse,
        ctx.weekendDefinition,
        {
          start: schedule.period.startDate,
          end: schedule.period.endDate,
          historyFrom: ctx.historyFrom,
        },
      ),
    );
  },
};
