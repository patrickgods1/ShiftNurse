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
 * While the rule is soft, both solvers price each finding (`tourRotation`, counted by
 * `tourRotationFindings` in `SolverModel` and by `tourRotationTerms` in CP-SAT), so Generate
 * steers around a breach without being forbidden one; the grid and compliance report flag it.
 * Made hard, every encoder and `SolverModel` forbid the breach. A change of tour is measured from
 * the shift the nurse last stopped working (`latestEndingBefore`), not from the start-order
 * neighbour, which a short shift nested inside a night would be. The rule is monotone under
 * removal on any schedule without overlaps (taking a shift away never adds a distinct tour or an
 * off-tour shift, and if removing B leaves C measured from an A on another tour, B ended after A
 * and started before C, so A → B was already as short a change), which is what
 * `SolverModel.isLegal` relies on when it re-checks a removal.
 * Overlapping shifts are the overlap rule's business and are skipped here.
 *
 * Career nurses (UC–CNA Art. 14 § O.1.a: ten years) are exempt from forced rotation: tours the
 * schedule gives them are held to one, and to their permanent tour if they have one whatever the
 * unit's enforcement setting, but a tour they asked for (a preferred shift type on it,
 * `requestedTours`) is theirs to work. Holding them to one tour outright turned the protection
 * against them: a career nurse who asked to pick up nights was flagged for her own request. A
 * nurse who is not exempt gets no such lift — the contract's caps protect her, and her wishes do
 * not waive them.
 *
 * Service is read from the roster so the exemption follows the nurse; setting each such nurse's
 * permanent tour by hand went stale on every anniversary. `effectiveTourLimits` is the one place
 * the exemption is decided — the rule, `SolverModel` (through this rule) and the CP-SAT encoder
 * all read it, so the grid and Generate cannot disagree about who may rotate.
 */

import type { Id, Nurse, ShiftType, Tour } from '../domain/entities.js';
import {
  describeDate,
  type IsoDate,
  minutesToHours,
  parseTimeOfDay,
  restMinutesBetween,
} from '../domain/time.js';
import { yearsOfService } from '../leave/accrual.js';
import { latestEndingBefore } from '../schedule/preceding.js';
import type { AssignmentView } from '../schedule/view.js';
import { hoursWords } from './format.js';
import {
  isWorked,
  nurseName,
  type Rule,
  type RuleContext,
  type Violation,
  violation,
} from './types.js';

export interface TourRotationParams {
  /** Most distinct tours (day, evening, night) a nurse may work in one schedule period. */
  maxToursPerPeriod: number;
  /** Hours between the end of a shift and the start of the nurse's next worked shift when the two are on different tours. */
  minHoursBetweenTours: number;
  /** Whether a nurse with a permanent tour may never be scheduled off it. */
  permanentTourEnforced: boolean;
  /** Whole years of service after which a nurse is held to one tour a schedule. Absent: nobody is exempt. */
  exemptAfterYearsOfService?: number;
}

export interface EffectiveTourLimits {
  maxToursPerPeriod: number;
  permanentTourEnforced: boolean;
  exempt: boolean;
  /** Tours the nurse asked for, which neither count toward nor break the limits. Empty unless exempt. */
  requested: ReadonlySet<Tour>;
}

const NO_TOURS: ReadonlySet<Tour> = new Set();

/** The tours a nurse asked for: the tour of each shift type she prefers. Unknown ids are ignored. */
export function requestedTours(
  nurseId: Id,
  ctx: Pick<RuleContext, 'preferredShiftTypesByNurse' | 'shiftTypes'>,
): ReadonlySet<Tour> {
  const preferred = ctx.preferredShiftTypesByNurse.get(nurseId);
  if (!preferred) return NO_TOURS;
  const tours = new Set<Tour>();
  for (const shiftType of ctx.shiftTypes) {
    if (preferred.has(shiftType.id)) tours.add(tourOf(shiftType));
  }
  return tours;
}

/** The limits one nurse is judged by this schedule, the career exemption applied. */
export function effectiveTourLimits(
  nurse: Pick<Nurse, 'seniorityDate' | 'hireDate'>,
  params: TourRotationParams,
  periodStart: IsoDate,
  requested: ReadonlySet<Tour>,
): EffectiveTourLimits {
  const threshold = params.exemptAfterYearsOfService;
  // Service is counted to the first day of the schedule, so one nurse is judged the same on every
  // day of it; an anniversary mid-schedule takes effect from the next one.
  const exempt =
    threshold !== undefined &&
    yearsOfService(nurse.hireDate ?? nurse.seniorityDate, periodStart) >= threshold;
  return exempt
    ? { maxToursPerPeriod: 1, permanentTourEnforced: true, exempt, requested }
    : {
        maxToursPerPeriod: params.maxToursPerPeriod,
        permanentTourEnforced: params.permanentTourEnforced,
        exempt,
        requested: NO_TOURS,
      };
}

/** Day starts 04:00–11:59, evening 12:00–17:59, night 18:00–03:59, by local start time. */
export function tourOf(shiftType: Pick<ShiftType, 'startTime'>): Tour {
  const start = parseTimeOfDay(shiftType.startTime);
  if (start >= 4 * 60 && start < 12 * 60) return 'day';
  if (start >= 12 * 60 && start < 18 * 60) return 'evening';
  return 'night';
}

/**
 * The one night test for rest after a night, the night cap and recovery after nights. A night is
 * a night *tour*: `isNight` is the differential's flag and also sits on a Title 38 evening tour,
 * which would otherwise be owed a night's rest and cap a run of evenings as nights. Fairness's
 * night count and the pay differential still read `isNight`, on purpose.
 */
export function isNightTour(shiftType: Pick<ShiftType, 'startTime'>): boolean {
  return tourOf(shiftType) === 'night';
}

const TOUR_ORDER: readonly Tour[] = ['day', 'evening', 'night'];

/**
 * One nurse's findings, from her worked timeline (start-sorted, lookback tail included). The rule
 * reports them, and `SolverModel` counts them while the rule is soft, so the grid and Generate
 * cannot disagree about how many there are.
 */
export function tourRotationFindings(
  timeline: readonly AssignmentView[],
  nurse: Nurse,
  params: TourRotationParams,
  ctx: Pick<RuleContext, 'preferredShiftTypesByNurse' | 'shiftTypes'>,
  periodStart: IsoDate,
): Violation[] {
  const violations: Violation[] = [];
  const inPeriod = timeline.filter((v) => v.inPeriod);
  const limits = effectiveTourLimits(nurse, params, periodStart, requestedTours(nurse.id, ctx));
  const why = limits.exempt
    ? ` ${nurseName(nurse)} is exempt from rotation after ` +
      `${params.exemptAfterYearsOfService} years of service.`
    : '';

  const tours = TOUR_ORDER.filter((t) => inPeriod.some((v) => tourOf(v.shiftType) === t));
  // A tour she asked for is hers to work: only the ones the schedule chose count, and only
  // their shifts are what the finding names.
  const counted = tours.filter((t) => !limits.requested.has(t));
  if (counted.length > limits.maxToursPerPeriod) {
    const named = inPeriod.filter((v) => !limits.requested.has(tourOf(v.shiftType)));
    const asked = tours.filter((t) => limits.requested.has(t));
    const askedFor =
      asked.length > 0
        ? ` Tours ${nurseName(nurse)} asked for (${asked.join(', ')}) do not count.`
        : '';
    violations.push(
      violation(
        tourRotationRule,
        'soft',
        'too_many_tours',
        `${nurseName(nurse)} is rotated across ${tours.length} tours this schedule ` +
          `(${tours.join(', ')}). Maximum is ${limits.maxToursPerPeriod}.${why}${askedFor}`,
        {
          amount: counted.length - limits.maxToursPerPeriod,
          nurseIds: [nurse.id],
          dates: named.map((v) => v.assignment.date),
          assignmentIds: named.map((v) => v.assignment.id),
          details: {
            tours,
            ...(limits.exempt
              ? { requested: TOUR_ORDER.filter((t) => limits.requested.has(t)) }
              : {}),
            max: limits.maxToursPerPeriod,
          },
        },
      ),
    );
  }

  const preceding = latestEndingBefore(timeline);
  for (let i = 0; i < timeline.length; i++) {
    const current = timeline[i]!;
    // Measured from the shift the nurse last stopped working, so a short day shift nested
    // inside a night does not hide the night → day change.
    const before = preceding[i]!;
    const first = before[0];
    if (!first) continue;
    // Overlaps belong to the overlap rule.
    const restMinutes = restMinutesBetween(first.window, current.window);
    if (restMinutes < 0) continue;
    const toTour = tourOf(current.shiftType);
    const previous = before.find((p) => tourOf(p.shiftType) !== toTour);
    if (!previous) continue;
    const fromTour = tourOf(previous.shiftType);
    const restHours = minutesToHours(restMinutes);
    if (restHours >= params.minHoursBetweenTours) continue;
    // History cannot be fixed; only flag when this schedule can do something about it.
    if (!previous.inPeriod && !current.inPeriod) continue;

    // The lookback row is history: the finding names only what this schedule can change.
    const inPeriodPair = [previous, current].filter((v) => v.inPeriod);
    violations.push(
      violation(
        tourRotationRule,
        'soft',
        'short_tour_change',
        `${nurseName(nurse)} has only ${hoursWords(restHours)} off between the ` +
          `${previous.shiftType.name} (${fromTour}) on ${describeDate(previous.assignment.date)} ` +
          `and the ${current.shiftType.name} (${toTour}) on ` +
          `${describeDate(current.assignment.date)}. ` +
          `${hoursWords(params.minHoursBetweenTours)} required when changing tour.`,
        {
          amount: params.minHoursBetweenTours - restHours,
          nurseIds: [nurse.id],
          dates: inPeriodPair.map((v) => v.assignment.date),
          assignmentIds: inPeriodPair.map((v) => v.assignment.id),
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
  if (permanent && limits.permanentTourEnforced) {
    for (const view of inPeriod) {
      const tour = tourOf(view.shiftType);
      if (tour === permanent || limits.requested.has(tour)) continue;
      violations.push(
        violation(
          tourRotationRule,
          'soft',
          'off_permanent_tour',
          `${nurseName(nurse)} is on a permanent ${permanent} tour but is scheduled the ` +
            `${view.shiftType.name} (${tour}) on ${describeDate(view.assignment.date)}.${why}`,
          {
            amount: 1,
            nurseIds: [nurse.id],
            dates: [view.assignment.date],
            assignmentIds: [view.assignment.id],
            details: { tour, permanentTour: permanent },
          },
        ),
      );
    }
  }

  return violations;
}

export const tourRotationRule: Rule<TourRotationParams> = {
  id: 'tour-rotation',
  name: 'Tour rotation limits',
  description:
    'Limits how many tours (day, evening, night) a nurse is rotated across in a schedule, requires ' +
    'a longer break when a nurse changes tour, and keeps a nurse on a permanent tour off the ' +
    'other tours. A tour is named by when the shift starts. Advisory: Generate steers away ' +
    'from a breach, and the grid flags it.',
  severity: 'soft',
  category: 'rest',
  scope: 'nurse',
  enabledByDefault: false,
  defaultParams: { maxToursPerPeriod: 2, minHoursBetweenTours: 48, permanentTourEnforced: true },
  paramDocs: {
    maxToursPerPeriod: {
      stricter: 'lower',
      label: 'Most tours per schedule',
      min: 1,
      hint: 'The most different tours (day, evening, night) one nurse may work in a schedule.',
      why:
        'Rotation clauses, such as VA–NNU Art. 13 and the UC–CNA contracts, cap how widely a ' +
        'nurse is moved around. Two is common; set 1 to keep every nurse on a single tour.',
      integer: true,
      max: 3,
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
    exemptAfterYearsOfService: {
      label: 'Exempt from rotation after (years)',
      hint:
        'Years of service after which a nurse is exempt from forced rotation and is kept on one ' +
        'tour per schedule (UC–CNA Art. 14 § O.1.a: ten years). Leave blank to exempt nobody.',
      why:
        'Some contracts spare career nurses rotation altogether. Service counts from the hire ' +
        'date, or the seniority date when no hire date is set, to the first day of the schedule; ' +
        'an exempt nurse with a permanent tour is kept on it even if permanent tours are not ' +
        'otherwise enforced.',
      optional: true,
      min: 0,
      integer: true,
    },
  },

  evaluate(schedule, params, ctx): Violation[] {
    return ctx.nurses.flatMap((nurse) =>
      tourRotationFindings(
        schedule.timelineFor(nurse.id).filter(isWorked),
        nurse,
        params,
        ctx,
        schedule.period.startDate,
      ),
    );
  },
};
