/**
 * Holdovers: minutes a nurse worked past a published shift's scheduled end, required by the
 * hospital or volunteered.
 *
 * Rules (consecutive-hours limits, 16-in-24) and pay (overtime beyond the scheduled tour) can
 * only see time that is on the record, and the schedule says when a shift was meant to end, not
 * when it did. A required holdover is a decision that can be grieved or fall under a
 * mandatory-overtime law, so it is audited with the reason that is quoted if it is challenged;
 * a volunteered one is an ordinary audited edit.
 *
 * Minutes that run into the nurse's own next worked shift, on any unit, are refused: the worked
 * window would overlap that shift, and its paid hours and weekly caps would count the same
 * minutes twice. The refusal comes before any write.
 */

import {
  type Assignment,
  addDays,
  describeDate,
  formatTimeOfDay,
  type Id,
  type IsoDate,
  shiftWindow,
} from '@shiftnurse/core';
import { and, asc, eq, gte, lte, ne } from 'drizzle-orm';
import { recordAudit, recordAuditStrict } from '../audit.js';
import type { DbLike } from '../client.js';
import { toAssignment } from '../mappers.js';
import { assignment, nurse, schedulePeriod, shiftType, unit } from '../schema.js';

/** A holdover longer than half a day is a data-entry slip, not a holdover. */
const MAX_HOLDOVER_MINUTES = 720;

export interface RecordHoldoverInput {
  assignmentId: Id;
  /** Minutes past the scheduled end; 0 clears a recorded holdover. Whole minutes, 0–720. */
  minutes: number;
  mandated: boolean;
  /** Required when `mandated` (it is what gets quoted if the holdover is grieved). */
  reason?: string;
}

export function recordHoldover(db: DbLike, input: RecordHoldoverInput, actor: string): Assignment {
  const row = db.select().from(assignment).where(eq(assignment.id, input.assignmentId)).get();
  if (!row) throw new Error(`Assignment ${input.assignmentId} not found`);
  const period = db.select().from(schedulePeriod).where(eq(schedulePeriod.id, row.periodId)).get();
  if (period?.status !== 'published') {
    throw new Error("A holdover is recorded on a published shift; change a draft's shift instead.");
  }
  const type = db.select().from(shiftType).where(eq(shiftType.id, row.shiftTypeId)).get();
  if (type?.isOnCall) {
    throw new Error('Standby is not worked time; record a call-back instead.');
  }
  const { minutes } = input;
  // Clearing is never a required holdover: there is nothing left to quote or grieve.
  const mandated = minutes === 0 ? false : input.mandated;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_HOLDOVER_MINUTES) {
    throw new Error(`A holdover is whole minutes from 0 to ${MAX_HOLDOVER_MINUTES}`);
  }
  const reason = input.reason?.trim();
  if (mandated && !reason) {
    throw new Error('Give a reason for a required holdover; it is what is quoted if it is grieved');
  }

  if (minutes > 0 && type) refuseIfRunsIntoNextShift(db, row, type, minutes);

  db.update(assignment)
    .set({ holdoverMinutes: minutes, holdoverMandated: minutes === 0 ? null : mandated })
    .where(eq(assignment.id, row.id))
    .run();
  const afterRow = db.select().from(assignment).where(eq(assignment.id, row.id)).get();
  if (!afterRow) throw new Error(`Assignment ${row.id} vanished during update`);
  const after = toAssignment(afterRow);

  const entry = {
    entityType: 'assignment',
    entityId: row.id,
    action: 'update' as const,
    actor,
    before: { holdoverMinutes: row.holdoverMinutes, holdoverMandated: row.holdoverMandated },
    after: { holdoverMinutes: minutes, holdoverMandated: afterRow.holdoverMandated },
    ...(reason ? { reason } : {}),
  };
  if (mandated) recordAuditStrict(db, entry, { requireReason: true });
  else recordAudit(db, entry);
  return after;
}

/**
 * Half-open: a shift starting exactly when the holdover ends is fine. One that started before the
 * scheduled end already overlaps the scheduled shift, which is the overlap rule's finding, not
 * this holdover's. Two days past the date is enough: a 24-hour shift starting at 23:59 plus the
 * 720-minute cap ends before noon two days later.
 */
function refuseIfRunsIntoNextShift(
  db: DbLike,
  row: typeof assignment.$inferSelect,
  type: typeof shiftType.$inferSelect,
  minutes: number,
): void {
  const scheduledEnd = shiftWindow(row.date as IsoDate, type).endMinute;
  const heldEnd = scheduledEnd + minutes;
  const others = db
    .select({
      date: assignment.date,
      type: shiftType,
      unitName: unit.name,
      firstName: nurse.firstName,
      lastName: nurse.lastName,
    })
    .from(assignment)
    .innerJoin(shiftType, eq(assignment.shiftTypeId, shiftType.id))
    .innerJoin(schedulePeriod, eq(assignment.periodId, schedulePeriod.id))
    .innerJoin(unit, eq(schedulePeriod.unitId, unit.id))
    .innerJoin(nurse, eq(assignment.nurseId, nurse.id))
    .where(
      and(
        eq(assignment.nurseId, row.nurseId),
        ne(assignment.id, row.id),
        eq(shiftType.isOnCall, false),
        gte(assignment.date, row.date),
        lte(assignment.date, addDays(row.date as IsoDate, 2)),
      ),
    )
    .orderBy(asc(assignment.date), asc(assignment.id))
    .all();
  let first: { start: number; other: (typeof others)[number] } | undefined;
  for (const other of others) {
    const start = shiftWindow(other.date as IsoDate, other.type).startMinute;
    if (start < scheduledEnd || start >= heldEnd) continue;
    if (!first || start < first.start) first = { start, other };
  }
  if (!first) return;
  const { other } = first;
  const where = other.type.unitId === type.unitId ? '' : ` on ${other.unitName}`;
  throw new Error(
    `${other.firstName} ${other.lastName} starts the ${other.type.name}${where} at ${formatTimeOfDay(first.start)} on ${describeDate(other.date as IsoDate)}, inside this holdover. Hold over at most ${first.start - scheduledEnd} minutes, or record the extra time on that shift.`,
  );
}
