/**
 * Accommodations: recurring windows a nurse cannot work (ADA, Title VII religious
 * accommodation, PWFA, the PUMP Act).
 *
 * A Sabbath from Friday sunset or a lactation window used to be either a soft preference or a
 * pile of approved time off, so Generate could still put the nurse inside it. Breaking one is a
 * legal problem, the same kind of promise as approved leave, so the rule is hard and both
 * solvers forbid the shift outright (`encodeAccommodationBlocks` asks `blockedAt` too).
 *
 * Unlike leave, which removes the shifts *dated* in it, a block is judged by wall-clock overlap:
 * "Friday 18:00 to Saturday 18:00" bars a Friday day shift that runs to 19:00 and a Saturday
 * morning, though the Saturday shift is dated outside the occurrence's own date. So an
 * occurrence is placed on the continuous timeline from its own date, and a shift is checked
 * against the occurrences dated the day before, the same day and the day after (a block can
 * begin the evening before; a night shift runs into tomorrow).
 *
 * The reason is HR- and medical-sensitive. It is audited and shown on Roster › Accommodations,
 * and never written into a violation message: those reach the grid, exports and grievances.
 */

import type { AvailabilityBlock, Id } from '../domain/entities.js';
import {
  addDays,
  dayNumber,
  describeDate,
  fromDayNumber,
  type IsoDate,
  MINUTES_PER_DAY,
  parseTimeOfDay,
  type ShiftWindow,
  weekdayOf,
  windowsOverlap,
} from '../domain/time.js';
import {
  isWorked,
  nurseName,
  type Rule,
  type RuleContext,
  type Violation,
  violation,
} from './types.js';

export interface AccommodationBlocksParams {
  /** Whether standby inside a blocked window counts as work the nurse cannot do. */
  onCallCounts: boolean;
}

/** One dated occurrence of a block, on the continuous timeline. */
export interface BlockOccurrence extends ShiftWindow {
  /** The date the occurrence starts on (a weekday the block names). */
  date: IsoDate;
}

/** The block's occurrence that starts on `date`, or undefined when it does not occur that day. */
function occurrenceOn(block: AvailabilityBlock, date: IsoDate): BlockOccurrence | undefined {
  if (!block.weekdays.includes(weekdayOf(date))) return undefined;
  // Inclusive both ways; either end absent = open.
  if (block.startsOn !== undefined && date < block.startsOn) return undefined;
  if (block.endsOn !== undefined && date > block.endsOn) return undefined;
  const start = parseTimeOfDay(block.startTime);
  const end = parseTimeOfDay(block.endTime);
  const startMinute = dayNumber(date) * MINUTES_PER_DAY + start;
  // At or before the start means past midnight; equal times are a full 24 hours.
  const endMinute = dayNumber(date) * MINUTES_PER_DAY + end + (end <= start ? MINUTES_PER_DAY : 0);
  return { date, startMinute, endMinute };
}

/**
 * The block's occurrences that overlap `window`, a shift dated `shiftDate`. Half-open, so a
 * shift ending when the block starts is clear.
 */
export function blockOccurrencesOverlapping(
  block: AvailabilityBlock,
  window: ShiftWindow,
  shiftDate: IsoDate,
): BlockOccurrence[] {
  const out: BlockOccurrence[] = [];
  for (const offset of [-1, 0, 1]) {
    const occurrence = occurrenceOn(block, addDays(shiftDate, offset));
    if (occurrence && windowsOverlap(window, occurrence)) out.push(occurrence);
  }
  return out;
}

/** The nurse's block, if any, that a shift dated `shiftDate` with this window runs into. */
export function blockedAt(
  ctx: Pick<RuleContext, 'availabilityBlocksByNurse'>,
  nurseId: Id,
  window: ShiftWindow,
  shiftDate: IsoDate,
): AvailabilityBlock | undefined {
  return ctx.availabilityBlocksByNurse
    .get(nurseId)
    ?.find((b) => blockOccurrencesOverlapping(b, window, shiftDate).length > 0);
}

/** "Fri 18:00 – Sat 18:00": the occurrence in words, weekdays only (it recurs). */
function describeOccurrence(block: AvailabilityBlock, occurrence: BlockOccurrence): string {
  const endDate = fromDayNumber(Math.floor((occurrence.endMinute - 1) / MINUTES_PER_DAY));
  const endWeekday = describeDate(endDate).slice(0, 3);
  return `${describeDate(occurrence.date).slice(0, 3)} ${block.startTime} – ${endWeekday} ${block.endTime}`;
}

export const accommodationBlocksRule: Rule<AccommodationBlocksParams> = {
  id: 'accommodation-blocks',
  name: 'Accommodations are absolute',
  description:
    'A nurse with a recorded accommodation (a religious, disability, pregnancy or lactation window) ' +
    'cannot be scheduled on any shift that overlaps it. Silent when the unit has none.',
  severity: 'hard',
  category: 'coverage',
  scope: 'nurse',
  defaultParams: { onCallCounts: true },
  paramDocs: {
    onCallCounts: {
      label: 'Standby counts',
      hint: 'Whether an on-call shift inside the window is also barred.',
      why:
        'On by default: standby inside a Sabbath or a lactation window is still work the nurse ' +
        'cannot do, because they must be able to come in. Turn it off only if your accommodations ' +
        'allow being reachable.',
    },
  },

  evaluate(schedule, params, ctx): Violation[] {
    const violations: Violation[] = [];
    for (const view of schedule.assignments()) {
      // History cannot be fixed; only this period's shifts are flagged.
      if (!view.inPeriod) continue;
      if (!params.onCallCounts && !isWorked(view)) continue;
      const blocks = ctx.availabilityBlocksByNurse.get(view.nurse.id);
      if (!blocks) continue;
      for (const block of blocks) {
        const occurrence = blockOccurrencesOverlapping(block, view.window, view.assignment.date)[0];
        if (!occurrence) continue;
        violations.push(
          violation(
            accommodationBlocksRule,
            'hard',
            'works_during_accommodation',
            `${nurseName(view.nurse)} is scheduled on the ${view.shiftType.name} on ` +
              `${describeDate(view.assignment.date)} inside a recorded accommodation ` +
              `(${describeOccurrence(block, occurrence)}).`,
            {
              nurseIds: [view.nurse.id],
              dates: [view.assignment.date],
              assignmentIds: [view.assignment.id],
              details: { availabilityBlockId: block.id },
            },
          ),
        );
        break; // one finding per shift, however many blocks it runs into
      }
    }
    return violations;
  },
};
