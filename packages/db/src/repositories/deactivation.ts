/**
 * Deactivating a nurse who leaves the unit.
 *
 * Flipping `active` alone once left her future shifts on the schedule: the grid hid her row, but
 * validation and the Staffing row still counted her, so a shift looked staffed by somebody who
 * was gone. Deactivation therefore takes her draft shifts off with her, and refuses while she
 * still holds a shift staff have already been given — that one is the manager's to reassign.
 */

import type { Assignment, Id, IsoDate, Nurse } from '@shiftnurse/core';
import { describeDate } from '@shiftnurse/core';
import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import type { DbLike, ShiftNurseTx } from '../client.js';
import { toAssignment } from '../mappers.js';
import { assignment, schedulePeriod, shiftType } from '../schema.js';
import { deactivateNurse, getNurse } from './roster.js';
import { deleteAssignment } from './schedule.js';

export interface FutureShift {
  assignment: Assignment;
  periodName: string;
  periodStatus: 'draft' | 'published';
  shiftTypeName: string;
}

export interface DeactivationResult {
  nurse: Nurse;
  lifted: Assignment[];
}

/**
 * The nurse's shifts dated `fromDate` or later on draft and published schedules, by date then
 * shift order. Archived periods are left out: an archived schedule is the record of what was
 * worked and is read-only, so nothing there can be lifted or reassigned, and a leaver's archived
 * shifts must stay exactly as they were.
 */
export function futureShiftsFor(db: DbLike, nurseId: Id, fromDate: IsoDate): FutureShift[] {
  return db
    .select({
      row: assignment,
      periodName: schedulePeriod.name,
      periodStatus: schedulePeriod.status,
      shiftTypeName: shiftType.name,
    })
    .from(assignment)
    .innerJoin(schedulePeriod, eq(schedulePeriod.id, assignment.periodId))
    .innerJoin(shiftType, eq(shiftType.id, assignment.shiftTypeId))
    .where(
      and(
        eq(assignment.nurseId, nurseId),
        gte(assignment.date, fromDate),
        inArray(schedulePeriod.status, ['draft', 'published']),
      ),
    )
    .orderBy(asc(assignment.date), asc(shiftType.sortOrder))
    .all()
    .map((r) => ({
      assignment: toAssignment(r.row),
      periodName: r.periodName,
      periodStatus: r.periodStatus as 'draft' | 'published',
      shiftTypeName: r.shiftTypeName,
    }));
}

/**
 * Takes the nurse's draft shifts from `fromDate` on off the schedule and marks her inactive.
 * A transaction, not any handle: a lift without the deactivation, or the deactivation without
 * the lift, leaves the grid and the roster disagreeing about whether she works here.
 * Published shifts are refused rather than edited — staff already hold that schedule, and a
 * posted change needs the manager's reason and a change-log row (`editSchedule` in main), which
 * a roster action cannot supply. Every refusal comes before the first write.
 */
export function deactivateNurseLiftingDrafts(
  db: ShiftNurseTx,
  nurseId: Id,
  fromDate: IsoDate,
  actor: string,
): DeactivationResult {
  const current = getNurse(db, nurseId);
  if (!current) throw new Error(`Nurse ${nurseId} not found`);
  const who = `${current.firstName} ${current.lastName}`;
  if (!current.active) throw new Error(`${who} is already inactive.`);
  const shifts = futureShiftsFor(db, nurseId, fromDate);
  const published = shifts.filter((s) => s.periodStatus === 'published');
  const first = published[0];
  if (first) {
    const n = published.length;
    const them = n === 1 ? 'it' : 'them';
    throw new Error(
      `${who} still has ${n} shift${n === 1 ? '' : 's'} on published schedules, the first on ` +
        `${describeDate(first.assignment.date)} (${first.shiftTypeName}, ${first.periodName}). ` +
        `Staff already hold ${them}: give ${them} away or remove ${them} on the schedule grid, ` +
        'with a reason, before deactivating.',
    );
  }
  const lifted = shifts.filter((s) => s.periodStatus === 'draft').map((s) => s.assignment);
  for (const a of lifted) {
    deleteAssignment(db, a.id, actor, `Lifted: ${who} was deactivated`);
  }
  return { nurse: deactivateNurse(db, nurseId, actor), lifted };
}
