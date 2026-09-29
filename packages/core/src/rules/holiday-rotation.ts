/**
 * Holiday rotation: who worked last year's Christmas has this year's off, and — when the unit
 * pairs them — whoever works Christmas Day is kept off Christmas Eve.
 *
 * Counting holidays worked (the fairness ledger's `holidaysWorked`) evens out *how many*
 * holidays each nurse works, but not *which*: a nurse can work Christmas every year and still
 * look even because someone else drew three minor Mondays. Units settle that with a rotation,
 * alternating years per holiday, and it is one of the first things raised in a grievance.
 *
 * "The same holiday last year" is matched by name (ignoring case and spacing) about a year
 * earlier, so a moving holiday such as Thanksgiving still finds its predecessor; who worked it
 * comes from `HolidayWorkRecord`s the caller loads — published schedules, or a list recorded by
 * hand for a year before the app. A nurse with no record (a new hire) is owed nothing.
 *
 * A worked shift is dated by the day it starts, as everywhere else: the night of the 24th is
 * not a Christmas shift. Standby is not working the holiday.
 *
 * The rule is soft, like the rest of fairness: it never blocks a schedule, it tells the
 * manager and the solver prices it (`holidayRotationFacts` is what both solvers read). Each
 * worked shift on a holiday the nurse is owed off is one breach; working both halves of a
 * pair is one breach for the pair.
 */

import type { Holiday, Id } from '../domain/entities.js';
import { addDays, compareDates, type IsoDate } from '../domain/time.js';
import type { HolidayWorkRecord, Rule, RuleContext, Violation } from './types.js';
import { isWorked, nurseName, violation } from './types.js';

export interface HolidayRotationParams {
  rotateMajorHolidays: boolean;
  rotateMinorHolidays: boolean;
  pairMinorWithMajor: boolean;
}

/** "last year" means an occurrence this many days before, give or take a moving holiday. */
const PREVIOUS_MIN_DAYS = 300;
const PREVIOUS_MAX_DAYS = 430;

/**
 * The key "the same holiday" is matched on: case, spacing and punctuation ignored, so "New Years
 * Day" is last year's "New Year’s Day". Anything more lenient would start matching different
 * holidays; a real mismatch shows on the Holidays tab, where a rename fixes it.
 */
export function holidayNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The same holiday about a year before `holiday`, if the unit has it. */
export function previousOccurrence(
  holiday: Holiday,
  holidays: readonly Holiday[],
): Holiday | undefined {
  const key = holidayNameKey(holiday.name);
  const earliest = addDays(holiday.date, -PREVIOUS_MAX_DAYS);
  const latest = addDays(holiday.date, -PREVIOUS_MIN_DAYS);
  let best: Holiday | undefined;
  for (const h of holidays) {
    if (h.id === holiday.id || holidayNameKey(h.name) !== key) continue;
    if (compareDates(h.date, earliest) < 0 || compareDates(h.date, latest) > 0) continue;
    if (best === undefined || compareDates(h.date, best.date) > 0) best = h;
  }
  return best;
}

/** The holiday indexes `RuleContext` carries, built once per evaluation pass. */
export function holidayIndexes(
  holidays: readonly Holiday[],
  work: readonly HolidayWorkRecord[],
): Pick<RuleContext, 'holidaysById' | 'holidaysByDate' | 'previousHoliday' | 'holidayWorkedBy'> {
  const previousHoliday = new Map<Id, Holiday>();
  for (const h of holidays) {
    const previous = previousOccurrence(h, holidays);
    if (previous) previousHoliday.set(h.id, previous);
  }
  const holidayWorkedBy = new Map<Id, Set<Id>>();
  for (const record of work) {
    const set = holidayWorkedBy.get(record.holidayId);
    if (set) set.add(record.nurseId);
    else holidayWorkedBy.set(record.holidayId, new Set([record.nurseId]));
  }
  return {
    holidaysById: new Map(holidays.map((h) => [h.id, h])),
    holidaysByDate: new Map(holidays.map((h) => [h.date, h])),
    previousHoliday,
    holidayWorkedBy,
  };
}

/** The major holiday a minor one is paired with, while the rule set pairs them. */
function pairedMajor(
  holiday: Holiday,
  params: HolidayRotationParams,
  ctx: RuleContext,
): Holiday | undefined {
  if (!params.pairMinorWithMajor || holiday.isMajor || holiday.pairedHolidayId === null) {
    return undefined;
  }
  const major = ctx.holidaysById.get(holiday.pairedHolidayId);
  return major?.isMajor ? major : undefined;
}

/** Whether a holiday rotates year over year under these params. */
function rotates(holiday: Holiday, params: HolidayRotationParams, ctx: RuleContext): boolean {
  if (holiday.isMajor) return params.rotateMajorHolidays;
  // A paired minor holiday follows its major instead of last year's list.
  return params.rotateMinorHolidays && pairedMajor(holiday, params, ctx) === undefined;
}

/** Did this nurse work last year's occurrence of this holiday? */
function owedOff(nurseId: Id, holiday: Holiday, ctx: RuleContext): Holiday | undefined {
  const previous = ctx.previousHoliday.get(holiday.id);
  if (!previous) return undefined;
  return ctx.holidayWorkedBy.get(previous.id)?.has(nurseId) ? previous : undefined;
}

export interface HolidayPair {
  minor: Holiday;
  major: Holiday;
}

export interface HolidayRotationFacts {
  /** nurse id → holiday dates in the period the nurse is owed off. */
  owedOff: ReadonlyMap<Id, ReadonlySet<IsoDate>>;
  /**
   * Paired holidays the period can judge: one half in it, the other in it or before it — the
   * lookback tail, or history (`workedInHistory`) however long ago. A pair whose other half is
   * still ahead is judged by the period that holds it, once this one is history.
   */
  pairs: readonly HolidayPair[];
}

/**
 * Whether the nurse worked a holiday dated before the period, by the history the caller loaded
 * (published schedules or a recorded list). Dates in the period are the schedule's to answer.
 */
export function workedInHistory(
  ctx: RuleContext,
  nurseId: Id,
  holiday: Holiday,
  periodStart: IsoDate,
): boolean {
  return (
    compareDates(holiday.date, periodStart) < 0 &&
    (ctx.holidayWorkedBy.get(holiday.id)?.has(nurseId) ?? false)
  );
}

/** What the solvers price, for one period under one rule configuration. */
export function holidayRotationFacts(
  ctx: RuleContext,
  params: HolidayRotationParams,
  window: { start: IsoDate; end: IsoDate },
): HolidayRotationFacts {
  const inPeriod = (d: IsoDate) =>
    compareDates(d, window.start) >= 0 && compareDates(d, window.end) <= 0;
  const notAhead = (d: IsoDate) => compareDates(d, window.end) <= 0;

  const owed = new Map<Id, Set<IsoDate>>();
  const pairs: HolidayPair[] = [];
  for (const holiday of ctx.holidaysById.values()) {
    if (inPeriod(holiday.date) && rotates(holiday, params, ctx)) {
      for (const nurse of ctx.nurses) {
        if (!owedOff(nurse.id, holiday, ctx)) continue;
        const set = owed.get(nurse.id);
        if (set) set.add(holiday.date);
        else owed.set(nurse.id, new Set([holiday.date]));
      }
    }
    const major = pairedMajor(holiday, params, ctx);
    if (
      major &&
      notAhead(holiday.date) &&
      notAhead(major.date) &&
      (inPeriod(holiday.date) || inPeriod(major.date))
    ) {
      pairs.push({ minor: holiday, major });
    }
  }
  pairs.sort((a, b) => compareDates(a.minor.date, b.minor.date));
  return { owedOff: owed, pairs };
}

export const holidayRotationRule: Rule<HolidayRotationParams> = {
  id: 'holiday-rotation',
  name: 'Holiday rotation',
  description:
    'Holidays alternate year to year: a nurse who worked last year’s Christmas has this year’s ' +
    'off, and one who had it off works it. Minor holidays can rotate the same way or be paired ' +
    'with a major holiday, so whoever works Christmas Day is off Christmas Eve. Last year’s ' +
    'list comes from published schedules, or can be recorded on the Holidays tab.',
  severity: 'soft',
  category: 'equity',
  scope: 'nurse',
  defaultParams: {
    rotateMajorHolidays: true,
    rotateMinorHolidays: true,
    pairMinorWithMajor: false,
  },
  paramDocs: {
    rotateMajorHolidays: {
      label: 'Rotate major holidays',
      hint: 'Whoever worked a major holiday last year is kept off it this year.',
      why:
        'Leave this on unless your unit settles major holidays another way, such as by ' +
        'seniority or sign-up.',
    },
    rotateMinorHolidays: {
      label: 'Rotate minor holidays',
      hint: 'Minor holidays alternate year to year on their own, the same way as majors.',
      why:
        'Turn it off if minor holidays are not worth rotating on your unit. With pairing on, a ' +
        'paired minor holiday follows its major holiday instead.',
    },
    pairMinorWithMajor: {
      label: 'Pair minor holidays with a major one',
      hint:
        'Whoever works a major holiday is kept off the minor holiday paired with it, and the ' +
        'reverse. Pairs are set on the Holidays tab.',
      why:
        'For units that split holidays between two halves of the team: work Christmas Eve or ' +
        'Christmas Day, Memorial Day or Thanksgiving, never both. Any minor holiday can pair ' +
        'with any major one. Unpaired minor holidays still rotate on their own if that is on.',
    },
  },

  evaluate(schedule, params, ctx): Violation[] {
    const violations: Violation[] = [];
    if (ctx.holidaysById.size === 0) return violations;

    for (const nurse of ctx.nurses) {
      const timeline = schedule.timelineFor(nurse.id).filter(isWorked);

      for (const view of timeline) {
        if (!view.inPeriod) continue;
        const holiday = ctx.holidaysByDate.get(view.assignment.date);
        if (!holiday || !rotates(holiday, params, ctx)) continue;
        const previous = owedOff(nurse.id, holiday, ctx);
        if (!previous) continue;
        violations.push(
          violation(
            holidayRotationRule,
            'soft',
            'holiday_rotation',
            `${nurseName(nurse)} worked ${previous.name} last year (${previous.date}) and is ` +
              `scheduled on it again on ${holiday.date}. The rotation gives it to someone who ` +
              'had it off.',
            {
              nurseIds: [nurse.id],
              dates: [holiday.date],
              assignmentIds: [view.assignment.id],
              details: { holidayId: holiday.id, previousHolidayId: previous.id },
            },
          ),
        );
      }

      if (!params.pairMinorWithMajor) continue;
      const start = schedule.period.startDate;
      for (const minor of ctx.holidaysById.values()) {
        const major = pairedMajor(minor, params, ctx);
        if (!major) continue;
        const onMinor = timeline.filter((v) => v.assignment.date === minor.date);
        const onMajor = timeline.filter((v) => v.assignment.date === major.date);
        // Judged only where this schedule works one half; the other may be any time before.
        if (![...onMinor, ...onMajor].some((v) => v.inPeriod)) continue;
        const workedMinor = onMinor.length > 0 || workedInHistory(ctx, nurse.id, minor, start);
        const workedMajor = onMajor.length > 0 || workedInHistory(ctx, nurse.id, major, start);
        if (!workedMinor || !workedMajor) continue;
        const [first, second] =
          compareDates(minor.date, major.date) <= 0 ? [minor, major] : [major, minor];
        violations.push(
          violation(
            holidayRotationRule,
            'soft',
            'holiday_pair_both',
            `${nurseName(nurse)} works both ${minor.name} (${minor.date}) and ${major.name} ` +
              `(${major.date}). Paired holidays go to different people.`,
            {
              nurseIds: [nurse.id],
              dates: [first.date, second.date],
              assignmentIds: [...onMinor, ...onMajor]
                .filter((v) => v.inPeriod)
                .map((v) => v.assignment.id),
              details: { minorHolidayId: minor.id, majorHolidayId: major.id },
            },
          ),
        );
      }
    }
    return violations;
  },
};
