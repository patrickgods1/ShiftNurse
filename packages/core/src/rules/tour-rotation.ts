/**
 * Tour rotation limits: how many tours a nurse is rotated across, how long a break a change of
 * tour needs, and keeping a permanent-tour nurse on their tour.
 *
 * VA–NNU Master Agreement Art. 13 and the UC–CNA contracts all limit rotation, because moving a
 * nurse from nights to days is a body-clock problem the plain minimum-rest rule cannot see: a
 * night ending 07:00 Tuesday and a day starting 07:00 Wednesday are 24 hours apart and perfectly
 * "rested". A nurse awarded a permanent tour has a stronger claim still — they are not rotated
 * off it at all. Without this rule the schedule looks fine on the grid while breaking all three.
 *
 * Tours are named by when they START, as contracts name them. `isNight` is a pay flag (and is
 * also set on a Title 38 evening tour), so it cannot say which tour a shift belongs to.
 *
 * Known limit: while the rule is soft, Generate does not price it, so it will not steer around a
 * breach; the grid and compliance report flag it. Made hard, every encoder and `SolverModel`
 * forbid the breach. It is monotone under removal (taking a shift away never adds a distinct
 * tour, an off-tour shift, or a closer pair of neighbours on a different tour — a shift left
 * between two others is at least as close to one of them on its own tour), which is what
 * `SolverModel.isLegal` relies on when it re-checks a removal. Overlapping shifts are the overlap
 * rule's business and are skipped here.
 */

import type { ShiftType, Tour } from '../domain/entities.js';
import {
  describeDate,
  minutesToHours,
  parseTimeOfDay,
  restMinutesBetween,
} from '../domain/time.js';
import { isWorked, nurseName, type Rule, type Violation, violation } from './types.js';

export interface TourRotationParams {
  /** Most distinct tours (day, evening, night) a nurse may work in one schedule period. */
  maxToursPerPeriod: number;
  /** Hours between the end of a shift and the start of the nurse's next worked shift when the two are on different tours. */
  minHoursBetweenTours: number;
  /** Whether a nurse with a permanent tour may never be scheduled off it. */
  permanentTourEnforced: boolean;
}

/** Day starts 04:00–11:59, evening 12:00–17:59, night 18:00–03:59, by local start time. */
export function tourOf(shiftType: Pick<ShiftType, 'startTime'>): Tour {
  const start = parseTimeOfDay(shiftType.startTime);
  if (start >= 4 * 60 && start < 12 * 60) return 'day';
  if (start >= 12 * 60 && start < 18 * 60) return 'evening';
  return 'night';
}

const TOUR_ORDER: readonly Tour[] = ['day', 'evening', 'night'];

function hoursText(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded} hour${rounded === 1 ? '' : 's'}`;
}

export const tourRotationRule: Rule<TourRotationParams> = {
  id: 'tour-rotation',
  name: 'Tour rotation limits',
  description:
    'Limits how many tours (day, evening, night) a nurse is rotated across in a schedule, requires ' +
    'a longer break when a nurse changes tour, and keeps a nurse on a permanent tour off the ' +
    'other tours. A tour is named by when the shift starts. Advisory: the grid flags a breach, ' +
    'but Generate only avoids it if you make the rule hard.',
  severity: 'soft',
  category: 'rest',
  scope: 'nurse',
  enabledByDefault: false,
  defaultParams: { maxToursPerPeriod: 2, minHoursBetweenTours: 48, permanentTourEnforced: true },
  paramDocs: {
    maxToursPerPeriod: {
      label: 'Most tours per schedule',
      min: 1,
      hint: 'The most different tours (day, evening, night) one nurse may work in a schedule.',
      why:
        'Rotation clauses, such as VA–NNU Art. 13 and the UC–CNA contracts, cap how widely a ' +
        'nurse is moved around. Two is common; set 1 to keep every nurse on a single tour.',
    },
    minHoursBetweenTours: {
      label: 'Break when changing tour (hours)',
      hint:
        'Hours off required between a shift and the nurse’s next shift when the two are on ' +
        'different tours.',
      why:
        'Changing tour needs longer than plain minimum rest to recover the body clock; 48 hours ' +
        'is the usual ask going from nights to days. Raise it if your contract says more.',
    },
    permanentTourEnforced: {
      label: 'Keep permanent-tour nurses on their tour',
      hint: 'Flags any shift on another tour for a nurse who has a permanent tour set.',
      why:
        'A nurse awarded a permanent tour is not rotated off it (VA–NNU Art. 13). Turn it off ' +
        'only if permanent tours on your unit are a preference, not a contract right.',
    },
  },

  evaluate(schedule, params, ctx): Violation[] {
    const violations: Violation[] = [];

    for (const nurse of ctx.nurses) {
      const timeline = schedule.timelineFor(nurse.id).filter(isWorked);
      const inPeriod = timeline.filter((v) => v.inPeriod);

      const tours = TOUR_ORDER.filter((t) => inPeriod.some((v) => tourOf(v.shiftType) === t));
      if (tours.length > params.maxToursPerPeriod) {
        violations.push(
          violation(
            tourRotationRule,
            'soft',
            'too_many_tours',
            `${nurseName(nurse)} is rotated across ${tours.length} tours this schedule ` +
              `(${tours.join(', ')}). Maximum is ${params.maxToursPerPeriod}.`,
            {
              nurseIds: [nurse.id],
              dates: inPeriod.map((v) => v.assignment.date),
              assignmentIds: inPeriod.map((v) => v.assignment.id),
              details: { tours, max: params.maxToursPerPeriod },
            },
          ),
        );
      }

      for (let i = 1; i < timeline.length; i++) {
        const previous = timeline[i - 1]!;
        const current = timeline[i]!;
        const fromTour = tourOf(previous.shiftType);
        const toTour = tourOf(current.shiftType);
        if (fromTour === toTour) continue;
        // Overlaps belong to the overlap rule.
        const restMinutes = restMinutesBetween(previous.window, current.window);
        if (restMinutes < 0) continue;
        const restHours = minutesToHours(restMinutes);
        if (restHours >= params.minHoursBetweenTours) continue;
        // History cannot be fixed; only flag when this schedule can do something about it.
        if (!previous.inPeriod && !current.inPeriod) continue;

        violations.push(
          violation(
            tourRotationRule,
            'soft',
            'short_tour_change',
            `${nurseName(nurse)} has only ${hoursText(restHours)} off between the ` +
              `${previous.shiftType.name} (${fromTour}) on ${describeDate(previous.assignment.date)} ` +
              `and the ${current.shiftType.name} (${toTour}) on ` +
              `${describeDate(current.assignment.date)}. ` +
              `${hoursText(params.minHoursBetweenTours)} required when changing tour.`,
            {
              nurseIds: [nurse.id],
              dates: [previous.assignment.date, current.assignment.date],
              assignmentIds: [previous.assignment.id, current.assignment.id],
              details: {
                restHours,
                requiredHours: params.minHoursBetweenTours,
                fromTour,
                toTour,
              },
            },
          ),
        );
      }

      const permanent = nurse.permanentTour;
      if (permanent && params.permanentTourEnforced) {
        for (const view of inPeriod) {
          const tour = tourOf(view.shiftType);
          if (tour === permanent) continue;
          violations.push(
            violation(
              tourRotationRule,
              'soft',
              'off_permanent_tour',
              `${nurseName(nurse)} is on a permanent ${permanent} tour but is scheduled the ` +
                `${view.shiftType.name} (${tour}) on ${describeDate(view.assignment.date)}.`,
              {
                nurseIds: [nurse.id],
                dates: [view.assignment.date],
                assignmentIds: [view.assignment.id],
                details: { tour, permanentTour: permanent },
              },
            ),
          );
        }
      }
    }

    return violations;
  },
};
