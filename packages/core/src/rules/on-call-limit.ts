/**
 * On-call limits: how often one nurse may be put on call, a week, a schedule, and in a row.
 *
 * Contracts ask for call to be shared, not capped: UC–CNA Art. 14 § K has assigned call
 * "distributed equitably" and names no number, and WSNA names none either (owner decision L-18).
 * The fairness ledger balances call across nurses over time, but it cannot stop one schedule from
 * putting the same nurse on call four nights of one week — a burden she carries now, whatever the
 * ledger evens out later. So the caps are the unit's own policy: every one optional, none
 * defaulted (absent is no limit), and the rule ships off, so neither a new rule set nor a stored
 * one changes until a manager writes a number in.
 *
 * Call is a shift whose type `isOnCall`, dated by its start as every shift is. A turn on call on
 * another unit counts: she is on call all the same, and a cap that ignored it could be dodged by
 * the roster she floats to. Nobody is exempt by employment type — a per-diem nurse taking call
 * carries the call.
 *
 * - **A week** is a calendar-date week from `workWeekStartsOn`, as `workWeekOf` reads it. The
 *   published lookback tail counts toward it, but a week is judged only when this schedule puts
 *   the nurse on call in it (history cannot be fixed). One finding per week over; the amount is
 *   how many over.
 * - **A schedule** counts the call dated inside it; the tail's call belongs to the schedule before.
 * - **Days in a row** is judged one window at a time: every `max + 1` consecutive dates each
 *   carrying call, holding one of this schedule's turns, is a finding of 1. A run one day too long
 *   is one finding; each further day is another. Per window rather than per run because that is
 *   what both solvers can price exactly (a window is a fixed set of dates; a run's extent is not),
 *   and the grid, SA and CP-SAT must agree on the count.
 *
 * Findings name only this schedule's turns on call in the week, schedule or window: adding one is
 * what makes the count grow, and removing one is what clears it. Soft, both solvers price each
 * finding (`onCallLimit`, fairness bucket: `SolverModel.onCallLimitFor` counts them with
 * `onCallLimitFindings`, CP-SAT with `onCallLimitTerms`); hard, `encodeOnCallLimit` caps the
 * counts. Monotone under removal — taking a turn on call off can only lower a count — so the
 * generic nurse-scope gate holds it.
 */

import type { Nurse } from '../domain/entities.js';
import {
  dateInRange,
  dayNumber,
  describeDate,
  describeDateRange,
  fromDayNumber,
  type IsoDate,
  type Weekday,
} from '../domain/time.js';
import type { AssignmentView, ScheduleView } from '../schedule/view.js';
import { workWeekOf } from './hours-rules.js';
import { nurseName, type Rule, type Violation, violation } from './types.js';

export interface OnCallLimitParams {
  /** First day of the week the weekly cap is counted in. */
  workWeekStartsOn: Weekday;
  /** The most turns on call in one work week. Absent: no limit. */
  maxOnCallPerWeek?: number;
  /** The most turns on call in one schedule. Absent: no limit. */
  maxOnCallPerPeriod?: number;
  /** The most consecutive dates on call. Absent: no limit. */
  maxConsecutiveOnCallDays?: number;
}

/** The schedule being judged. */
export interface OnCallSpan {
  start: IsoDate;
  end: IsoDate;
}

/** "3 times" / "1 time". */
function times(n: number): string {
  return `${n} time${n === 1 ? '' : 's'}`;
}

/**
 * One nurse's findings from her timeline (lookback tail and other units' shifts included; the
 * shifts that are not call are skipped here). The rule reports them and `SolverModel` counts them
 * while the rule is soft, so the grid and Generate cannot disagree about how many there are.
 */
export function onCallLimitFindings(
  timeline: readonly AssignmentView[],
  nurse: Nurse,
  params: OnCallLimitParams,
  span: OnCallSpan,
): Violation[] {
  const calls = timeline
    .filter((v) => v.shiftType.isOnCall)
    .sort((a, b) =>
      a.assignment.date < b.assignment.date ? -1 : a.assignment.date > b.assignment.date ? 1 : 0,
    );
  if (!calls.some((v) => v.inPeriod)) return [];
  const name = nurseName(nurse);
  const out: Violation[] = [];
  const named = (views: readonly AssignmentView[]) => {
    const own = views.filter((v) => v.inPeriod);
    return {
      nurseIds: [nurse.id],
      dates: own.map((v) => v.assignment.date),
      assignmentIds: own.map((v) => v.assignment.id),
    };
  };

  const weekCap = params.maxOnCallPerWeek;
  if (weekCap !== undefined) {
    const weeks = new Map<IsoDate, AssignmentView[]>();
    for (const v of calls) {
      const start = workWeekOf(v.assignment.date, params.workWeekStartsOn).start;
      const list = weeks.get(start);
      if (list) list.push(v);
      else weeks.set(start, [v]);
    }
    for (const [weekStart, views] of weeks) {
      if (views.length <= weekCap || !views.some((v) => v.inPeriod)) continue;
      out.push(
        violation(
          onCallLimitRule,
          'soft',
          'too_much_on_call',
          `${name} is on call ${times(views.length)} in the week of ` +
            `${describeDate(weekStart, { year: true })}; this unit allows ${weekCap}.`,
          {
            amount: views.length - weekCap,
            ...named(views),
            details: { count: views.length, maximum: weekCap, weekStart },
          },
        ),
      );
    }
  }

  const periodCap = params.maxOnCallPerPeriod;
  if (periodCap !== undefined) {
    // Dated inside the schedule: another unit's call that falls in it counts, the tail's does not.
    const views = calls.filter((v) => dateInRange(v.assignment.date, span.start, span.end));
    if (views.length > periodCap) {
      out.push(
        violation(
          onCallLimitRule,
          'soft',
          'too_much_on_call',
          `${name} is on call ${times(views.length)} in this schedule ` +
            `(${describeDateRange(span.start, span.end)}); this unit allows ${periodCap}.`,
          {
            amount: views.length - periodCap,
            ...named(views),
            details: { count: views.length, maximum: periodCap },
          },
        ),
      );
    }
  }

  const runCap = params.maxConsecutiveOnCallDays;
  if (runCap !== undefined) {
    const byDay = new Map<number, AssignmentView[]>();
    for (const v of calls) {
      const day = dayNumber(v.assignment.date);
      const list = byDay.get(day);
      if (list) list.push(v);
      else byDay.set(day, [v]);
    }
    const size = runCap + 1;
    // Every window of `size` dates on call, by its first date (`byDay` is in date order).
    for (const first of byDay.keys()) {
      const views: AssignmentView[] = [];
      let full = true;
      for (let d = first; d < first + size && full; d++) {
        const day = byDay.get(d);
        if (day) views.push(...day);
        else full = false;
      }
      if (!full || !views.some((v) => v.inPeriod)) continue;
      const from = fromDayNumber(first);
      const to = fromDayNumber(first + size - 1);
      const when = size === 1 ? describeDate(from, { year: true }) : describeDateRange(from, to);
      out.push(
        violation(
          onCallLimitRule,
          'soft',
          'too_much_on_call',
          `${name} is on call ${size} day${size === 1 ? '' : 's'} in a row (${when}); ` +
            `this unit allows ${runCap}.`,
          {
            amount: 1,
            ...named(views),
            details: { days: size, maximum: runCap, from },
          },
        ),
      );
    }
  }
  return out;
}

export const onCallLimitRule: Rule<OnCallLimitParams> = {
  id: 'on-call-limit',
  name: 'On-call limits',
  description:
    'Caps how often one nurse is put on call: in a work week, in a schedule, and on days in a ' +
    'row. Each cap is the unit’s own policy and applies only once a number is set. Call taken ' +
    'last schedule counts toward this week and toward days in a row.',
  severity: 'soft',
  category: 'equity',
  scope: 'nurse',
  enabledByDefault: false,
  defaultParams: { workWeekStartsOn: 0 },
  paramDocs: {
    workWeekStartsOn: {
      label: 'Work week starts on',
      hint: 'The first day of the week the weekly on-call cap is counted in.',
      why: 'Match the week your call rota is drawn up in; most units start it on Sunday.',
      input: 'weekday',
    },
    maxOnCallPerWeek: {
      stricter: 'lower',
      label: 'Most times on call in a week',
      hint: 'Leave blank for no weekly limit.',
      why:
        'Contracts ask for call to be shared equitably but rarely name a number (UC–CNA Art. 14 ' +
        '§ K). Set one if your unit has agreed how much call one nurse carries in a week.',
      optional: true,
      integer: true,
    },
    maxOnCallPerPeriod: {
      stricter: 'lower',
      label: 'Most times on call in a schedule',
      hint: 'Leave blank for no limit per schedule. Call from last schedule does not count.',
      why:
        'A per-schedule cap spreads call across the rota when a weekly cap alone would still let ' +
        'one nurse take the most every week.',
      optional: true,
      integer: true,
    },
    maxConsecutiveOnCallDays: {
      stricter: 'lower',
      label: 'Most days on call in a row',
      hint: 'Leave blank for no limit. Each day on call past it is flagged.',
      why:
        'Call nights back to back mean broken sleep night after night, even when the nurse is ' +
        'never called in. Set this if your unit limits call in a row.',
      optional: true,
      integer: true,
    },
  },

  evaluate(schedule: ScheduleView, params, ctx): Violation[] {
    const span = { start: schedule.period.startDate, end: schedule.period.endDate };
    return ctx.nurses.flatMap((nurse) =>
      onCallLimitFindings(schedule.timelineFor(nurse.id), nurse, params, span),
    );
  },
};
