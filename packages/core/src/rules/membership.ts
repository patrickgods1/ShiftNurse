/**
 * A float works on this unit only within the dates she floats to it.
 *
 * A float membership (`UnitMembership`) puts a nurse from another unit on this unit's roster from
 * a start date to an end date, and that is all the roster knows of it: a period she touches for
 * one day lists her for all fourteen. Without this rule Generate, conflicts, exchanges and day-of
 * could place her on any day of the period — a week before she arrives or after she has gone
 * home, a shift her own unit is counting on her for.
 *
 * Not modelled as leave on purpose: leave earns paid-leave credits, takes days out of fairness
 * exposure and counts as a request, none of which a float's days elsewhere are.
 *
 * A shift is judged by its start date, inclusive at both ends, as `nurseWorksOnUnit` reads a
 * one-day range: Sunday's night that runs into Monday is Sunday's, inside a membership ending on
 * Sunday. Standby here is judged too; the lookback tail is never flagged. A nurse with no
 * membership (a home nurse) is never judged.
 *
 * Hard, on by default and silent on a unit with no floats. Neither solver places a float outside
 * her dates (`SolverModel.eligible`, CP-SAT makes no variable there, hence `'by-construction'`),
 * and day-of lists her as excluded with the reason. `outsideMembership` is the one test.
 */

import type { Id } from '../domain/entities.js';
import { compareDates, describeDate, type IsoDate } from '../domain/time.js';
import { nurseName, type Rule, type RuleContext, type Violation, violation } from './types.js';

export type WorksWithinMembershipParams = Record<string, never>;

/** Whether `date` falls outside the nurse's membership; false for a nurse with none. */
export function outsideMembership(ctx: RuleContext, nurseId: Id, date: IsoDate): boolean {
  const m = ctx.membershipByNurse.get(nurseId);
  if (m === undefined) return false;
  return (
    (m.startDate !== undefined && compareDates(date, m.startDate) < 0) ||
    (m.endDate !== undefined && compareDates(date, m.endDate) > 0)
  );
}

function datesText(startDate: IsoDate | undefined, endDate: IsoDate | undefined): string {
  if (startDate !== undefined && endDate !== undefined) {
    return `from ${describeDate(startDate)} to ${describeDate(endDate)}`;
  }
  return startDate !== undefined
    ? `from ${describeDate(startDate)}`
    : `until ${describeDate(endDate!)}`;
}

export const worksWithinMembershipRule: Rule<WorksWithinMembershipParams> = {
  id: 'works-within-membership',
  name: 'Float dates on this unit',
  description:
    'A nurse floated in from another unit works here only between the start and end dates of ' +
    'her float assignment. A shift counts on the day it starts. Nurses homed on this unit are ' +
    'not judged.',
  severity: 'hard',
  category: 'coverage',
  scope: 'nurse',
  enabledByDefault: true,
  defaultParams: {},
  paramDocs: {},

  evaluate(schedule, _params, ctx): Violation[] {
    const violations: Violation[] = [];
    for (const nurse of ctx.nurses) {
      const m = ctx.membershipByNurse.get(nurse.id);
      if (m === undefined) continue;
      for (const view of schedule.timelineFor(nurse.id)) {
        if (!view.inPeriod) continue;
        const date = view.assignment.date;
        if (!outsideMembership(ctx, nurse.id, date)) continue;
        violations.push(
          violation(
            worksWithinMembershipRule,
            'hard',
            'outside_membership',
            `${nurseName(nurse)} floats to this unit ${datesText(m.startDate, m.endDate)}; ` +
              `the ${view.shiftType.name} on ${describeDate(date)} is outside it.`,
            {
              amount: 1,
              nurseIds: [nurse.id],
              dates: [date],
              assignmentIds: [view.assignment.id],
              details: {
                ...(m.startDate !== undefined ? { membershipStart: m.startDate } : {}),
                ...(m.endDate !== undefined ? { membershipEnd: m.endDate } : {}),
              },
            },
          ),
        );
      }
    }
    return violations;
  },
};
