/**
 * Schedule periods and assignments.
 *
 * This is the table `ScheduleView` (in `@shiftnurse/core`) is built from: rules, scoring and
 * the solver never see a row, only the `Assignment`/`SchedulePeriod` entities this module
 * returns. Keeping every read and write here — including the lookback tail and the
 * locked-cell-preserving rewrite — is what lets the solver, the manual grid editor and the
 * publish flow all share one source of truth for "what did we actually schedule."
 *
 * A period's status changes only through `publishSchedule` (`publish.ts`), which always writes a
 * version, and `archivePeriod`; a status write anywhere else would leave a published period
 * with no version for its change log to hang from.
 */

import type { Assignment, Id, IsoDate, PeriodStatus, SchedulePeriod } from '@shiftnurse/core';
import {
  addDays,
  compareDates,
  dateInRange,
  describeDate,
  describeDateRange,
  isIsoDate,
} from '@shiftnurse/core';
import { and, asc, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { recordAudit, recordAuditStrict, requireAuditReason } from '../audit.js';
import type { DbLike, ShiftNurseTx } from '../client.js';
import { ids } from '../ids.js';
import { toAssignment, toSchedulePeriod } from '../mappers.js';
import { assignment, nurse, schedulePeriod, shiftType } from '../schema.js';
import { insertRows } from './bulk.js';
import { type PatchKeys, patchOf } from './patch.js';

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

/** Newest first — the periods list opens on the most recently created schedule. */
export function listPeriodsForUnit(db: DbLike, unitId: Id): SchedulePeriod[] {
  return db
    .select()
    .from(schedulePeriod)
    .where(eq(schedulePeriod.unitId, unitId))
    .orderBy(desc(schedulePeriod.startDate))
    .all()
    .map(toSchedulePeriod);
}

export function getPeriod(db: DbLike, periodId: Id): SchedulePeriod | undefined {
  const row = db.select().from(schedulePeriod).where(eq(schedulePeriod.id, periodId)).get();
  return row ? toSchedulePeriod(row) : undefined;
}

/**
 * The unit's current draft, if any. A unit works on one draft at a time — this is what the
 * "continue editing" entry point on the schedule screen resolves against.
 */
export function getCurrentDraft(db: DbLike, unitId: Id): SchedulePeriod | undefined {
  const row = db
    .select()
    .from(schedulePeriod)
    .where(and(eq(schedulePeriod.unitId, unitId), eq(schedulePeriod.status, 'draft')))
    .orderBy(desc(schedulePeriod.startDate))
    .get();
  return row ? toSchedulePeriod(row) : undefined;
}

export interface CreatePeriodInput {
  unitId: Id;
  name: string;
  startDate: IsoDate;
  endDate: IsoDate;
  ruleSetId: Id;
  ruleSetVersion: number;
  requestsCloseOn?: IsoDate;
}

/** Refuses a backwards period before writing: `datesInRange` over one is empty, so every rule
 * would judge nothing and the schedule would read as clean. A one-day period is fine. */
export function createPeriod(db: DbLike, input: CreatePeriodInput, actor: string): SchedulePeriod {
  if (!isIsoDate(input.startDate)) {
    throw new Error(`The period's start date "${input.startDate}" is not a date.`);
  }
  if (!isIsoDate(input.endDate)) {
    throw new Error(`The period's end date "${input.endDate}" is not a date.`);
  }
  if (compareDates(input.endDate, input.startDate) < 0) {
    throw new Error('The period ends before it starts.');
  }
  const id = ids.period();
  const row = {
    id,
    unitId: input.unitId,
    name: input.name,
    startDate: input.startDate,
    endDate: input.endDate,
    status: 'draft' as PeriodStatus,
    publishedAt: null,
    ruleSetId: input.ruleSetId,
    ruleSetVersion: input.ruleSetVersion,
    requestsCloseOn: input.requestsCloseOn ?? null,
  };
  db.insert(schedulePeriod).values(row).run();
  const created = toSchedulePeriod(row);
  recordAudit(db, {
    entityType: 'schedule_period',
    entityId: id,
    action: 'create',
    actor,
    after: created,
  });
  return created;
}

/**
 * When time-off requests for this period close: the request window units run, after which a
 * request is late and decided first-come with a cover plan. Undefined clears it. Advisory — the
 * app flags late requests, it never refuses them. Setting the date it already has writes nothing,
 * so a field that commits on blur cannot leave audit noise.
 */
export function setRequestsCloseOn(
  db: DbLike,
  periodId: Id,
  date: IsoDate | undefined,
  actor: string,
): SchedulePeriod {
  const before = getPeriod(db, periodId);
  if (!before) throw new Error(`Schedule period ${periodId} not found`);
  if ((before.requestsCloseOn ?? undefined) === date) return before;
  db.update(schedulePeriod)
    .set({ requestsCloseOn: date ?? null })
    .where(eq(schedulePeriod.id, periodId))
    .run();
  const after = getPeriod(db, periodId)!;
  recordAudit(db, {
    entityType: 'schedule_period',
    entityId: periodId,
    action: 'update',
    actor,
    before,
    after,
  });
  return after;
}

/**
 * Close a published schedule: from here it is the record of what was worked, and every edit is
 * refused (`requirePeriodEditable`). Only a published period can be archived — archiving a draft
 * would freeze a proposal that never went out — and the reason is strict, since a closed
 * schedule is what gets quoted when a pay period is disputed.
 */
export function archivePeriod(
  db: DbLike,
  periodId: Id,
  actor: string,
  reason: string,
): SchedulePeriod {
  const before = getPeriod(db, periodId);
  if (!before) throw new Error(`Schedule period ${periodId} not found`);
  if (before.status === 'draft') {
    throw new Error(`"${before.name}" is a draft; only a published schedule can be archived.`);
  }
  if (before.status === 'archived') throw new Error(`"${before.name}" is already archived.`);
  // Checked before the write so a blank reason leaves nothing behind.
  const trimmed = requireAuditReason({
    entityType: 'schedule_period',
    entityId: periodId,
    action: 'update',
    reason,
  });
  db.update(schedulePeriod)
    .set({ status: 'archived' })
    .where(eq(schedulePeriod.id, periodId))
    .run();
  const after = getPeriod(db, periodId)!;
  recordAuditStrict(
    db,
    {
      entityType: 'schedule_period',
      entityId: periodId,
      action: 'update',
      actor,
      before,
      after,
      reason: trimmed,
    },
    { requireReason: true },
  );
  return after;
}

/** Only a draft can be deleted — a published period is history, not a mistake to undo. */
export function deleteDraftPeriod(db: DbLike, periodId: Id, actor: string): void {
  const before = getPeriod(db, periodId);
  if (!before) throw new Error(`Schedule period ${periodId} not found`);
  if (before.status !== 'draft') {
    throw new Error(
      `Schedule period ${periodId} is ${before.status}, not a draft; refusing to delete`,
    );
  }
  db.delete(schedulePeriod).where(eq(schedulePeriod.id, periodId)).run();
  recordAudit(db, {
    entityType: 'schedule_period',
    entityId: periodId,
    action: 'delete',
    actor,
    before,
  });
}

// ---------------------------------------------------------------------------
// Assignments — reads
// ---------------------------------------------------------------------------

export function listAssignmentsForPeriod(db: DbLike, periodId: Id): Assignment[] {
  return db
    .select()
    .from(assignment)
    .where(eq(assignment.periodId, periodId))
    .orderBy(asc(assignment.date))
    .all()
    .map(toAssignment);
}

export function getAssignment(db: DbLike, assignmentId: Id): Assignment | undefined {
  const row = db.select().from(assignment).where(eq(assignment.id, assignmentId)).get();
  return row ? toAssignment(row) : undefined;
}

/** Inclusive on both ends, matching how `IsoDate` ranges are expressed everywhere else. */
export function listAssignmentsForNurseInRange(
  db: DbLike,
  nurseId: Id,
  start: IsoDate,
  end: IsoDate,
): Assignment[] {
  return db
    .select()
    .from(assignment)
    .where(
      and(eq(assignment.nurseId, nurseId), gte(assignment.date, start), lte(assignment.date, end)),
    )
    .orderBy(asc(assignment.date))
    .all()
    .map(toAssignment);
}

/** One period's shifts starting on one date. Scoped to the period: a date alone spans units. */
export function listAssignmentsForPeriodOnDate(
  db: DbLike,
  periodId: Id,
  date: IsoDate,
): Assignment[] {
  return db
    .select()
    .from(assignment)
    .where(and(eq(assignment.periodId, periodId), eq(assignment.date, date)))
    .all()
    .map(toAssignment);
}

/**
 * The lookback tail `ScheduleView` needs to evaluate rest and consecutive-shift rules across
 * a period boundary: assignments in `[startDate - lookbackDays, startDate - 1]`.
 *
 * Published and archived periods only. An archived period is the record of what was worked, so
 * archiving one must not make its last night vanish from the next period's rest check. An
 * unpublished draft is a proposal, not something the nurse actually worked — pulling in a sibling
 * draft's guesses would let one draft's assumptions silently constrain another, and would make a
 * rest violation appear or disappear depending on the order two drafts happen to be edited in.
 */
export function priorAssignmentsBefore(
  db: DbLike,
  unitId: Id,
  startDate: IsoDate,
  lookbackDays: number,
): Assignment[] {
  const lookbackStart = addDays(startDate, -lookbackDays);
  const lookbackEnd = addDays(startDate, -1);
  const publishedPeriodIds = db
    .select({ id: schedulePeriod.id })
    .from(schedulePeriod)
    .where(
      and(
        eq(schedulePeriod.unitId, unitId),
        inArray(schedulePeriod.status, ['published', 'archived']),
      ),
    )
    .all()
    .map((r) => r.id);
  if (publishedPeriodIds.length === 0) return [];
  return db
    .select()
    .from(assignment)
    .where(
      and(
        inArray(assignment.periodId, publishedPeriodIds),
        gte(assignment.date, lookbackStart),
        lte(assignment.date, lookbackEnd),
      ),
    )
    .orderBy(asc(assignment.date))
    .all()
    .map(toAssignment);
}

// ---------------------------------------------------------------------------
// Assignments — writes
// ---------------------------------------------------------------------------

export interface CreateAssignmentInput {
  periodId: Id;
  nurseId: Id;
  shiftTypeId: Id;
  date: IsoDate;
  source?: Assignment['source'];
  isLocked?: boolean;
  isCharge?: boolean;
  isOvertime?: boolean;
  notes?: string;
}

/**
 * The one place that decides whether a shift may sit where it is being put. Out-of-period rows
 * are invisible on the grid yet still feed FMLA hours, accrual and the next lookback, and a
 * foreign shift type is costed with the wrong differentials, so every writer asks before it
 * inserts. `typeUnitId` is undefined when the shift type does not exist.
 */
function placeableOrThrow(period: SchedulePeriod, date: string, typeUnitId: Id | undefined): void {
  if (!isIsoDate(date)) throw new Error(`"${date}" is not a date.`);
  if (!dateInRange(date, period.startDate, period.endDate)) {
    throw new Error(
      `${describeDate(date, { year: true })} is outside ${period.name} (${describeDateRange(period.startDate, period.endDate)}).`,
    );
  }
  if (typeUnitId !== period.unitId)
    throw new Error("That shift is not one of this unit's shift types.");
}

export function createAssignment(
  db: DbLike,
  input: CreateAssignmentInput,
  actor: string,
  reason?: string,
): Assignment {
  const period = getPeriod(db, input.periodId);
  if (!period) throw new Error(`Schedule period ${input.periodId} not found`);
  const type = db.select().from(shiftType).where(eq(shiftType.id, input.shiftTypeId)).get();
  placeableOrThrow(period, input.date, type?.unitId);
  const id = ids.assignment();
  const row = {
    id,
    periodId: input.periodId,
    nurseId: input.nurseId,
    shiftTypeId: input.shiftTypeId,
    date: input.date,
    source: input.source ?? 'manual',
    isLocked: input.isLocked ?? false,
    isCharge: input.isCharge ?? false,
    isOvertime: input.isOvertime ?? false,
    notes: input.notes ?? null,
    holdoverMinutes: 0,
    holdoverMandated: null,
    floatedTo: null,
  };
  db.insert(assignment).values(row).run();
  const created = toAssignment(row);
  recordAudit(db, {
    entityType: 'assignment',
    entityId: id,
    action: 'create',
    actor,
    after: created,
    reason,
  });
  return created;
}

/**
 * What an in-place edit may change: the flags and the note. Where and when the shift is —
 * `date`, `shiftTypeId`, `nurseId` — changes only through `moveAssignment`, which refuses a
 * locked row and lets the change log record a removal plus an addition rather than an edit.
 */
export type UpdateAssignmentInput = Partial<
  Pick<CreateAssignmentInput, 'isLocked' | 'isCharge' | 'isOvertime' | 'notes'>
>;

const ASSIGNMENT_PATCH_KEYS: PatchKeys<UpdateAssignmentInput> = {
  isLocked: true,
  isCharge: true,
  isOvertime: true,
  notes: true,
};

export function updateAssignment(
  db: DbLike,
  assignmentId: Id,
  patch: UpdateAssignmentInput,
  actor: string,
  reason?: string,
): Assignment {
  const beforeRow = db.select().from(assignment).where(eq(assignment.id, assignmentId)).get();
  if (!beforeRow) throw new Error(`Assignment ${assignmentId} not found`);
  const before = toAssignment(beforeRow);
  const values = patchOf(patch, ASSIGNMENT_PATCH_KEYS, 'assignment');
  // Unlocked, the next Generate would delete the shift she worked on another unit.
  if (before.floatedTo !== undefined && patch.isLocked === false) {
    throw new Error(
      `This shift was floated to ${before.floatedTo} and stays fixed as a record of the day. Remove it if the float was entered by mistake.`,
    );
  }
  db.update(assignment).set(values).where(eq(assignment.id, assignmentId)).run();
  const afterRow = db.select().from(assignment).where(eq(assignment.id, assignmentId)).get();
  if (!afterRow) throw new Error(`Assignment ${assignmentId} vanished during update`);
  const after = toAssignment(afterRow);
  recordAudit(db, {
    entityType: 'assignment',
    entityId: assignmentId,
    action: 'update',
    actor,
    before,
    after,
    reason,
  });
  return after;
}

/**
 * A deleted assignment leaves no other trace of itself, so the full row goes into `before` —
 * this audit entry is the only remaining record that the shift was ever scheduled.
 */
export function deleteAssignment(
  db: DbLike,
  assignmentId: Id,
  actor: string,
  reason?: string,
): void {
  const beforeRow = db.select().from(assignment).where(eq(assignment.id, assignmentId)).get();
  if (!beforeRow) throw new Error(`Assignment ${assignmentId} not found`);
  const before = toAssignment(beforeRow);
  db.delete(assignment).where(eq(assignment.id, assignmentId)).run();
  recordAudit(db, {
    entityType: 'assignment',
    entityId: assignmentId,
    action: 'delete',
    actor,
    before,
    reason,
  });
}

/**
 * Marks the nurse's shift as worked on another unit (D20). The row stays — she worked the hours —
 * locked, because a day-of fact is not the solver's to move, and is never counted on this
 * unit's floor again.
 */
export function markFloatedOff(
  tx: ShiftNurseTx,
  assignmentId: Id,
  toUnit: string,
  actor: string,
  reason?: string,
): Assignment {
  const beforeRow = tx.select().from(assignment).where(eq(assignment.id, assignmentId)).get();
  if (!beforeRow) throw new Error('That shift is no longer on the schedule.');
  const unitName = toUnit.trim();
  if (unitName === '') throw new Error('Name the unit the nurse is floated to');
  const before = toAssignment(beforeRow);
  if (before.floatedTo !== undefined) {
    const who = tx.select().from(nurse).where(eq(nurse.id, before.nurseId)).get();
    throw new Error(
      `${who ? `${who.firstName} ${who.lastName}` : 'This nurse'} was already floated to ${before.floatedTo} for this shift.`,
    );
  }
  tx.update(assignment)
    .set({ floatedTo: unitName, isLocked: true })
    .where(eq(assignment.id, assignmentId))
    .run();
  const after = toAssignment({ ...beforeRow, floatedTo: unitName, isLocked: true });
  recordAudit(tx, {
    entityType: 'assignment',
    entityId: assignmentId,
    action: 'update',
    actor,
    before,
    after,
    reason,
  });
  return after;
}

export interface MoveAssignmentTarget {
  nurseId: Id;
  shiftTypeId: Id;
  date: IsoDate;
  /**
   * Overrides the carried charge flag. A resolution sets it to what it was simulated with: a
   * move judged as "charge on the empty night" written without the flag leaves that shift with
   * no charge nurse on the grid.
   */
  isCharge?: boolean;
}

/** Shared with `approveSwap`, so a swap and a grid move refuse in the same words. */
export function holdoverRefusal(row: Assignment): string {
  return (
    `This shift has a recorded ${row.holdoverMinutes}-minute holdover, which belongs to the ` +
    'nurse and day that worked it. Clear the holdover on Today first if the shift really changed.'
  );
}

/**
 * Move a shift to another nurse, date or shift type. `nurseId` is immutable on an assignment,
 * so a move is a delete and a create; callers run it inside `transact` so the grid never
 * observes a half-moved shift. Charge, overtime authorisation and notes describe the shift,
 * not the cell it sits in, so they travel with it — otherwise a drop silently strips the charge
 * nurse. Locked rows refuse to move: the lock is the manager's pin.
 */
export function moveAssignment(
  // A transaction, not any handle: these writes are only correct all-or-nothing.
  db: ShiftNurseTx,
  assignmentId: Id,
  target: MoveAssignmentTarget,
  actor: string,
  source: Assignment['source'] = 'manual',
  reason?: string,
): Assignment {
  const existing = getAssignment(db, assignmentId);
  if (!existing) throw new Error(`Assignment ${assignmentId} not found`);
  if (existing.isLocked) throw new Error('Cannot move a locked assignment');
  // Delete + create would drop the minutes, and carrying them to another nurse, day or shift
  // would invent worked time; refusing is the only answer that is true.
  if ((existing.holdoverMinutes ?? 0) > 0) throw new Error(holdoverRefusal(existing));
  deleteAssignment(db, assignmentId, actor, reason);
  return createAssignment(
    db,
    {
      periodId: existing.periodId,
      nurseId: target.nurseId,
      shiftTypeId: target.shiftTypeId,
      date: target.date,
      source,
      isCharge: target.isCharge ?? existing.isCharge,
      isOvertime: existing.isOvertime,
      ...(existing.notes !== undefined ? { notes: existing.notes } : {}),
    },
    actor,
    reason,
  );
}

/**
 * Wipe and rewrite a period's assignments with a fresh solver result.
 *
 * Rows with `isLocked: true` are preserved untouched rather than deleted and recreated —
 * they are the manager's pinned decisions, and the solver's job is to solve *around* them,
 * never to silently overwrite one because a regeneration happened to run. Any locked
 * assignment present in `assignments` is expected to be the same locked row coming back
 * through the solver's own output; either way, the existing locked row on disk wins.
 * Floated-off rows are locked, so Generate keeps them too.
 */
export function replaceAssignments(
  // A transaction, not any handle: these writes are only correct all-or-nothing.
  db: ShiftNurseTx,
  periodId: Id,
  assignments: readonly CreateAssignmentInput[],
  actor: string,
  /** Merged into the `generate` audit entry — which solver ran, and whether it fell back. */
  auditDetails: Record<string, unknown> = {},
): Assignment[] {
  const period = getPeriod(db, periodId);
  if (!period) throw new Error(`Schedule period ${periodId} not found`);
  // Solver output that fails here is a bug upstream; refuse before deleting anything.
  const typeUnits = new Map(
    db
      .select({ id: shiftType.id, unitId: shiftType.unitId })
      .from(shiftType)
      .where(eq(shiftType.unitId, period.unitId))
      .all()
      .map((t) => [t.id, t.unitId] as const),
  );
  for (const input of assignments)
    placeableOrThrow(period, input.date, typeUnits.get(input.shiftTypeId));
  const existing = db.select().from(assignment).where(eq(assignment.periodId, periodId)).all();
  const lockedRows = existing.filter((r) => r.isLocked);
  const unlockedRows = existing.filter((r) => !r.isLocked);
  const unlockedIds = unlockedRows.map((r) => r.id);
  // Regenerating rewrites rows, and a recorded holdover cannot ride along to a new one.
  const held = unlockedRows.find((r) => r.holdoverMinutes > 0);
  if (held) throw new Error(holdoverRefusal(toAssignment(held)));

  // Only the unlocked rows are wiped. Locked rows are never touched by this function — that
  // is the guarantee the manager's pin depends on.
  if (unlockedIds.length > 0) {
    db.delete(assignment).where(inArray(assignment.id, unlockedIds)).run();
  }

  // Solver output may echo a locked cell back as one of its own proposed assignments (it had
  // to know the cell was occupied to solve around it). Skip those rather than trying to
  // insert a second row for the same nurse/date/shift, which the unique index would reject.
  const lockedKey = (r: { nurseId: Id; date: string; shiftTypeId: Id }): string =>
    `${r.nurseId}::${r.date}::${r.shiftTypeId}`;
  const lockedKeys = new Set(lockedRows.map(lockedKey));

  const rows: (typeof assignment.$inferSelect)[] = [];
  for (const input of assignments) {
    if (lockedKeys.has(lockedKey(input))) continue;
    const id = ids.assignment();
    rows.push({
      id,
      periodId,
      nurseId: input.nurseId,
      shiftTypeId: input.shiftTypeId,
      date: input.date,
      source: input.source ?? 'solver',
      isLocked: input.isLocked ?? false,
      isCharge: input.isCharge ?? false,
      isOvertime: input.isOvertime ?? false,
      notes: input.notes ?? null,
      holdoverMinutes: 0,
      holdoverMandated: null,
      floatedTo: null,
    });
  }
  insertRows(db, assignment, rows);
  const created = rows.map(toAssignment);

  const preserved = lockedRows.map(toAssignment);
  const result = [...preserved, ...created];
  recordAudit(db, {
    entityType: 'schedule_period',
    entityId: periodId,
    action: 'generate',
    actor,
    // The deleted rows go in `before`: after a regeneration this is the only record of who
    // was on the grid, and "who was I replaced by, and when" is what a grievance asks.
    before: {
      removed: unlockedRows.map((r) => ({
        id: r.id,
        nurseId: r.nurseId,
        date: r.date,
        shiftTypeId: r.shiftTypeId,
      })),
    },
    after: { ...auditDetails, created: created.length, preservedLocked: preserved.length },
  });
  return result;
}

export function setLocked(
  db: DbLike,
  assignmentId: Id,
  isLocked: boolean,
  actor: string,
): Assignment {
  return updateAssignment(db, assignmentId, { isLocked }, actor);
}
