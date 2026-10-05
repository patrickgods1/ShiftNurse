/**
 * An orientee works only with their preceptor on the floor.
 *
 * A new hire, or a nurse learning the unit, is oriented by a named preceptor, and for the weeks
 * of orientation may not carry patients without them: that is what makes the orientation real,
 * and what a board of nursing asks about after an incident. The novice rule asks only for *an*
 * experienced RN; this rule asks for *the* preceptor. Present means on the same shift, or on the
 * shift a shorter one runs inside (as for the novice rule, `schedule/cover.ts`) — a preceptor on a
 * mid 8 is not with an orientee for the whole of a day 12.
 *
 * Shift scope: one shift's roster, with its covering shift's, decides it. Hard, and on in every
 * rule set; with no preceptorships recorded it never fires. Both solvers price a breach as a short
 * shift (`hardShortfall`); CP-SAT through `encodePreceptor`.
 */

import type { Id, Nurse, Preceptorship } from '../domain/entities.js';
import { dateInRange, describeDate, type IsoDate } from '../domain/time.js';
import { coveringShift } from '../schedule/cover.js';
import type { Rule, RuleContext, Violation } from './types.js';
import { isWorked, nurseName, violation } from './types.js';

export type PreceptorParams = Record<string, never>;

/** The preceptors in force for an orientee on a shift dated `date`; empty when not oriented. */
export function preceptorsOn(
  ctx: Pick<RuleContext, 'preceptorshipsByOrientee'>,
  orienteeId: Id,
  date: IsoDate,
): Id[] {
  return (ctx.preceptorshipsByOrientee.get(orienteeId) ?? [])
    .filter((p: Preceptorship) => dateInRange(date, p.startDate, p.endDate))
    .map((p) => p.preceptorId);
}

export const preceptorRule: Rule<PreceptorParams> = {
  id: 'orientee-with-preceptor',
  name: 'Orientees work with their preceptor',
  description:
    'A nurse in orientation works only on shifts their preceptor is on (Roster › Orientation). ' +
    'A preceptor on the shift an orientee’s shorter shift runs inside counts.',
  severity: 'hard',
  category: 'safety',
  scope: 'shift',
  defaultParams: {},
  paramDocs: {},

  evaluate(schedule, _params, ctx): Violation[] {
    if (ctx.preceptorshipsByOrientee.size === 0) return [];
    const violations: Violation[] = [];
    for (const date of schedule.dates) {
      for (const shiftType of ctx.shiftTypes) {
        const assigned = schedule.onShift(date, shiftType.id);
        if (assigned.length === 0) continue;
        const cover = coveringShift(shiftType, date, schedule.shiftTypesById);
        const present = new Set(
          [...assigned, ...(cover ? schedule.rosterAt(cover.date, cover.shiftType.id) : [])].map(
            (v) => v.nurse.id,
          ),
        );
        for (const view of assigned) {
          if (!isWorked(view)) continue;
          const preceptors = preceptorsOn(ctx, view.nurse.id, date);
          if (preceptors.length === 0 || preceptors.some((id) => present.has(id))) continue;
          const names = preceptors.map((id) => {
            const nurse = schedule.nursesById.get(id) ?? ctx.nurses.find((n: Nurse) => n.id === id);
            return nurse ? nurseName(nurse) : id;
          });
          const who =
            names.length === 1
              ? `${names[0]}, who is not`
              : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}, neither of whom is`;
          violations.push(
            violation(
              preceptorRule,
              'hard',
              'orientee_without_preceptor',
              `${nurseName(view.nurse)} is in orientation with ${who} on the ${shiftType.name} on ` +
                `${describeDate(date)}.`,
              {
                dates: [date],
                nurseIds: [view.nurse.id],
                assignmentIds: [view.assignment.id],
                details: { preceptorIds: preceptors, shiftTypeId: shiftType.id },
              },
            ),
          );
        }
      }
    }
    return violations;
  },
};
