/**
 * Days a nurse has asked off while the request still waits for a decision.
 *
 * Nothing stops a schedule being generated before every request is decided, and the solver
 * used to treat a pending request as if it did not exist: it put Mei Haddad on as charge for
 * the first two days of her wedding leave, so approving it afterwards left both shifts short.
 * A pending request is not leave — the manager may still deny it — but it is the nurse saying
 * which days they cannot easily work. So working one is a warning on the grid, and both solvers
 * price it per shift (`pendingTimeOff`, above any single preference, far below a short shift),
 * which keeps those days free whenever the unit can spare them and makes approving later cheap.
 *
 * The request's days are the shifts dated in it, as for approved leave (see the time-off rule).
 */

import type { Id, TimeOffRequest } from '../domain/entities.js';
import { dateInRange, describeDate, describeDateRange, type IsoDate } from '../domain/time.js';
import { describeType } from './availability-rules.js';
import type { Rule, RuleContext, Violation } from './types.js';
import { isWorked, nurseName, violation } from './types.js';

export type PendingTimeOffParams = Record<string, never>;

/** The pending request a shift dated `date` falls in, if any. */
export function pendingRequestOn(
  ctx: Pick<RuleContext, 'allTimeOff'>,
  nurseId: Id,
  date: IsoDate,
): TimeOffRequest | undefined {
  return ctx.allTimeOff.find(
    (r) =>
      r.nurseId === nurseId && r.status === 'pending' && dateInRange(date, r.startDate, r.endDate),
  );
}

export const pendingTimeOffRule: Rule<PendingTimeOffParams> = {
  id: 'avoid-pending-time-off',
  name: 'Days asked off, not yet decided',
  description:
    'Warns when a nurse is scheduled inside a time-off request that is still pending. Generate ' +
    'keeps those days free when it can, so approving the request later leaves no gap.',
  severity: 'soft',
  category: 'coverage',
  scope: 'nurse',
  defaultParams: {},
  paramDocs: {},

  evaluate(schedule, _params, ctx): Violation[] {
    const violations: Violation[] = [];
    for (const view of schedule.assignments()) {
      if (!isWorked(view)) continue;
      const request = pendingRequestOn(ctx, view.nurse.id, view.assignment.date);
      if (!request) continue;
      violations.push(
        violation(
          pendingTimeOffRule,
          'soft',
          'works_during_pending_time_off',
          `${nurseName(view.nurse)} is scheduled for the ${view.shiftType.name} on ` +
            `${describeDate(view.assignment.date)}, inside a ${describeType(request)} request ` +
            `still waiting for a decision (${describeDateRange(request.startDate, request.endDate)}). ` +
            'Decide the request, or move the shift.',
          {
            nurseIds: [view.nurse.id],
            dates: [view.assignment.date],
            assignmentIds: [view.assignment.id],
            details: { timeOffRequestId: request.id },
          },
        ),
      );
    }
    return violations;
  },
};
