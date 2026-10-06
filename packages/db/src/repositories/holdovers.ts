/**
 * Holdovers: minutes a nurse worked past a published shift's scheduled end, required by the
 * hospital or volunteered.
 *
 * Rules (consecutive-hours limits, 16-in-24) and pay (overtime beyond the scheduled tour) can
 * only see time that is on the record, and the schedule says when a shift was meant to end, not
 * when it did. A required holdover is a decision that can be grieved or fall under a
 * mandatory-overtime law, so it is audited with the reason that is quoted if it is challenged;
 * a volunteered one is an ordinary audited edit.
 */

import type { Assignment, Id } from '@shiftnurse/core';
import { eq } from 'drizzle-orm';
import { recordAudit, recordAuditStrict } from '../audit.js';
import type { DbLike } from '../client.js';
import { toAssignment } from '../mappers.js';
import { assignment, schedulePeriod, shiftType } from '../schema.js';

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
