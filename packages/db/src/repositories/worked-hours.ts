/**
 * Hours a nurse actually worked, for the leave tests that count them: FMLA's 1,250 hours in the
 * last 12 months (29 CFR 825.110(c) counts hours actually worked), the 52-week average week, and
 * per-hour accrual.
 *
 * Three readings of "worked" were each once wrong. A draft is a proposal, not work, so its rows
 * would credit hours nobody has worked yet; only a published or archived period's shifts count.
 * A shift worked on another unit is still work, so the shift's own type prices it, not the home
 * unit's list (which priced a float night at 0). On-call standby is not work. The declared
 * `durationHours` is the length, never end minus start.
 *
 * A published shift whose call-off was left uncovered still counts: the row carries no mark that
 * the nurse was absent.
 */

import type { Id, IsoDate } from '@shiftnurse/core';
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { DbLike } from '../client.js';
import { assignment, schedulePeriod, shiftType } from '../schema.js';

/** Hours a nurse actually worked, per shift, on any unit: rows of published or archived
 *  periods only (a draft is a proposal, not work), on-call standby excluded, each at its own
 *  shift type's declared `durationHours`. Inclusive range, oldest first. */
export function workedShiftsForNurseInRange(
  db: DbLike,
  nurseId: Id,
  start: IsoDate,
  end: IsoDate,
): { date: IsoDate; hours: number }[] {
  return db
    .select({ date: assignment.date, hours: shiftType.durationHours })
    .from(assignment)
    .innerJoin(schedulePeriod, eq(schedulePeriod.id, assignment.periodId))
    .innerJoin(shiftType, eq(shiftType.id, assignment.shiftTypeId))
    .where(
      and(
        eq(assignment.nurseId, nurseId),
        gte(assignment.date, start),
        lte(assignment.date, end),
        inArray(schedulePeriod.status, ['published', 'archived']),
        eq(shiftType.isOnCall, false),
      ),
    )
    .orderBy(asc(assignment.date), asc(assignment.id))
    .all()
    .map((r) => ({ date: r.date as IsoDate, hours: r.hours }));
}
