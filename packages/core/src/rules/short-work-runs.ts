/**
 * Short work runs: a nurse's days worked come in runs of at least so many in a row.
 *
 * INRC-II's "minimum consecutive working days" pattern term (owner decision L-35). A lone day
 * worked between two days off fragments the week: the days off either side are single days, never
 * a real break, and the nurse commutes in for one shift. `max-consecutive-shifts` caps how long a
 * run may be and cannot see how short one is, so without this rule Generate would happily scatter
 * a nurse's shifts one day at a time and call the result legal.
 *
 * A run is what `max-consecutive-shifts` reads (`buildStretches`): consecutive dates with a worked
 * shift *dated* on them, by its start — a Monday night ending Tuesday morning works Monday only.
 * Standby is not work. Another unit's shift is a day worked: the nurse came in that day all the
 * same, as the consecutive-days cap counts it. The published lookback tail counts toward a run, but
 * a run is judged only when it holds an in-period shift (history cannot be fixed), and a run
 * reaching the schedule's last day is left to the next schedule, which may lengthen it. With
 * `RuleContext.historyFrom` set, a run whose day before falls before the schedule and before the
 * complete history is not judged either: a gap in the tail looks exactly like a day off
 * (`schedule/history.ts`), and the run may well have started earlier. Nurses of an exempt
 * employment type (per diem by default: they take the days they are offered) are not judged.
 *
 * Soft and off by default, so no existing unit changes. While soft, both solvers price each
 * finding (`shortWorkRun`, preferences bucket: `SolverModel.shortWorkRunFor` counts them with
 * `shortWorkRunFindings`, CP-SAT with `shortWorkRunTerms`); hard, `encodeShortWorkRuns` forbids
 * them. Monotone under neither addition nor removal — taking Tuesday from Monday and Tuesday
 * leaves Monday alone — so `SolverModel.isLegal`'s re-check after a removal is what holds the gate.
 */

import type { Nurse } from '../domain/entities.js';
import {
  dayNumber,
  describeDate,
  describeDateRange,
  fromDayNumber,
  type IsoDate,
} from '../domain/time.js';
import type { AssignmentView, ScheduleView } from '../schedule/view.js';
import { buildStretches } from './rest-rules.js';
import { isWorked, nurseName, type Rule, type Violation, violation } from './types.js';

export interface ShortWorkRunsParams {
  /** The fewest days in a row a nurse should work once she comes in at all. Whole days, ≥ 2. */
  minConsecutiveDays: number;
  /** Employment types never judged: they work the days they are offered. */
  exemptEmploymentTypes: string[];
}

/** The schedule a run is judged in, and how far back its published tail is complete. */
export interface RunSpan {
  start: IsoDate;
  end: IsoDate;
  /** `RuleContext.historyFrom`: absent when nobody has said the tail is complete. */
  historyFrom: IsoDate | undefined;
}

/**
 * Whether a run of days `startDay..endDay` (day numbers) may be judged by this schedule: it ends
 * before the schedule's last day, and the day before it is on record. Shared by the rule and the
 * CP-SAT encoder, so the two judge the same runs.
 */
export function judgesRun(startDay: number, endDay: number, span: RunSpan): boolean {
  if (endDay >= dayNumber(span.end)) return false;
  const before = startDay - 1;
  return !(
    span.historyFrom !== undefined &&
    before < dayNumber(span.start) &&
    before < dayNumber(span.historyFrom)
  );
}

/** Whether this nurse's runs are judged at all. */
export function judgesRunsOf(nurse: Nurse, params: ShortWorkRunsParams): boolean {
  return !params.exemptEmploymentTypes.includes(nurse.employmentType);
}

/**
 * One nurse's findings from her worked timeline (lookback tail and other units' shifts included;
 * standby already filtered out). The rule reports them and `SolverModel` counts them while the
 * rule is soft, so the grid and Generate cannot disagree about how many there are.
 */
export function shortWorkRunFindings(
  timeline: readonly AssignmentView[],
  nurse: Nurse,
  params: ShortWorkRunsParams,
  span: RunSpan,
): Violation[] {
  if (!judgesRunsOf(nurse, params)) return [];
  const min = params.minConsecutiveDays;
  const violations: Violation[] = [];
  for (const run of buildStretches(timeline)) {
    if (!run.touchesPeriod || run.length >= min) continue;
    if (!judgesRun(run.startDay, run.endDay, span)) continue;
    // Every in-period shift of the run: adding a day beside it is what clears it, and each of
    // these is what makes it a run at all.
    const shifts = run.views.filter((v) => v.inPeriod);
    const first = fromDayNumber(run.startDay);
    const last = fromDayNumber(run.endDay);
    const when =
      run.length === 1 ? describeDate(first, { year: true }) : describeDateRange(first, last);
    violations.push(
      violation(
        shortWorkRunsRule,
        'soft',
        'short_work_run',
        `${nurseName(nurse)} works only ${run.length} day${run.length === 1 ? '' : 's'} in a row ` +
          `(${when}); the unit asks for at least ${min}.`,
        {
          amount: min - run.length,
          nurseIds: [nurse.id],
          dates: shifts.map((v) => v.assignment.date),
          assignmentIds: shifts.map((v) => v.assignment.id),
          details: { length: run.length, minimum: min },
        },
      ),
    );
  }
  return violations;
}

export const shortWorkRunsRule: Rule<ShortWorkRunsParams> = {
  id: 'short-work-runs',
  name: 'Short work runs',
  description:
    'A nurse who comes in works at least so many days in a row: a lone day worked between days ' +
    'off breaks up her week for one shift. A day counts as worked when a shift starts on it, on ' +
    'this unit or another. Runs reaching the schedule’s last day are left to the next schedule.',
  severity: 'soft',
  category: 'equity',
  scope: 'nurse',
  enabledByDefault: false,
  defaultParams: { minConsecutiveDays: 2, exemptEmploymentTypes: ['per_diem'] },
  paramDocs: {
    minConsecutiveDays: {
      stricter: 'higher',
      label: 'Fewest days in a row',
      min: 2,
      integer: true,
      hint:
        'The shortest run of days worked in a row a nurse should get. 2 flags a single day ' +
        'worked between two days off.',
      why:
        'Single days in a row fragment a week: the days off either side are never a real break. ' +
        'Two is the usual floor; raise it if your staff prefer longer blocks of work and rest.',
    },
    exemptEmploymentTypes: {
      label: 'Not judged for',
      hint: 'Employment types whose short runs are never flagged.',
      why:
        'Per-diem staff take the days they are offered, often one at a time by choice. Tick any ' +
        'other type your unit schedules the same way.',
      input: 'employment-types',
    },
  },

  evaluate(schedule: ScheduleView, params, ctx): Violation[] {
    const span: RunSpan = {
      start: schedule.period.startDate,
      end: schedule.period.endDate,
      historyFrom: ctx.historyFrom,
    };
    return ctx.nurses.flatMap((nurse) =>
      shortWorkRunFindings(schedule.timelineFor(nurse.id).filter(isWorked), nurse, params, span),
    );
  },
};
