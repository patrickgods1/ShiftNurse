/**
 * Holidays beyond the calendar itself: moving one between major and minor, pairing a minor
 * holiday with a major one, and who worked each past holiday — the history the holiday rotation
 * reads (`@shiftnurse/core`'s `holiday-rotation.ts`).
 *
 * Who worked a holiday comes from published schedules unless the manager has recorded it by
 * hand, which is how a unit starts the rotation with a year that predates the app, or corrects
 * a schedule that did not match who came in. A recorded list is authoritative even when empty:
 * "nobody on today's roster worked it" is an answer, not a gap.
 */

import type {
  Holiday,
  HolidayWorkRecord,
  Id,
  IsoDate,
  PairTarget,
  PlannedHoliday,
} from '@shiftnurse/core';
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike, ShiftNurseTx } from '../client.js';
import { ids } from '../ids.js';
import { toHoliday } from '../mappers.js';
import {
  assignment,
  holiday as holidayTable,
  holidayWork,
  schedulePeriod,
  shiftType,
} from '../schema.js';
import { type PatchKeys, patchOf } from './patch.js';

export interface HolidayPatch {
  name?: string;
  isMajor?: boolean;
  pairedHolidayId?: Id | null;
}

const HOLIDAY_PATCH_KEYS: PatchKeys<HolidayPatch> = {
  name: true,
  isMajor: true,
  pairedHolidayId: true,
};

function holidayOrThrow(db: DbLike, id: Id): Holiday {
  const row = db.select().from(holidayTable).where(eq(holidayTable.id, id)).get();
  if (!row) throw new Error(`Holiday ${id} not found`);
  return toHoliday(row);
}

/** Refuse a pairing the rotation could not honour, naming why. */
export function assertHolidayPairing(db: DbLike, holiday: Omit<Holiday, 'id'>): void {
  if (holiday.pairedHolidayId === null) return;
  if (holiday.isMajor) {
    throw new Error(`${holiday.name} is a major holiday; only a minor holiday is paired with one`);
  }
  const partner = holidayOrThrow(db, holiday.pairedHolidayId);
  if (partner.unitId !== holiday.unitId) {
    throw new Error(`${partner.name} belongs to another unit`);
  }
  if (!partner.isMajor) {
    throw new Error(
      `${partner.name} is not a major holiday, so ${holiday.name} cannot pair with it`,
    );
  }
}

export type HolidayInput = Omit<Holiday, 'id' | 'pairedHolidayId'> & {
  /** A minor holiday's major partner; see `Holiday.pairedHolidayId`. */
  pairedHolidayId?: Id | null;
};

export function createHoliday(db: DbLike, input: HolidayInput, actor: string): Holiday {
  const id = ids.holiday();
  const holiday: Omit<Holiday, 'id'> = {
    unitId: input.unitId,
    date: input.date,
    name: input.name,
    isMajor: input.isMajor,
    pairedHolidayId: input.isMajor ? null : (input.pairedHolidayId ?? null),
  };
  assertHolidayPairing(db, holiday);
  const row: typeof holidayTable.$inferInsert = { id, ...holiday };
  db.insert(holidayTable).values(row).run();
  const after = toHoliday(row as typeof holidayTable.$inferSelect);
  recordAudit(db, { entityType: 'holiday', entityId: id, action: 'create', actor, after });
  return after;
}

/**
 * Rename a holiday, move it between major and minor, or pair it. A major holiday is never
 * paired, so making one major drops its pairing; making a major minor unpairs the minors that
 * pointed at it — several rows only right together, hence the transaction.
 */
export function updateHoliday(
  tx: ShiftNurseTx,
  id: Id,
  patch: HolidayPatch,
  actor: string,
): Holiday {
  const before = holidayOrThrow(tx, id);
  const merged: Holiday = { ...before, ...patchOf(patch, HOLIDAY_PATCH_KEYS, 'holiday') };
  if (merged.name.trim() === '') throw new Error('A holiday needs a name');
  const after: Holiday = merged.isMajor ? { ...merged, pairedHolidayId: null } : merged;
  assertHolidayPairing(tx, after);

  tx.update(holidayTable)
    .set({ name: after.name, isMajor: after.isMajor, pairedHolidayId: after.pairedHolidayId })
    .where(eq(holidayTable.id, id))
    .run();
  recordAudit(tx, { entityType: 'holiday', entityId: id, action: 'update', actor, before, after });

  if (before.isMajor && !after.isMajor) unpairMinorsOf(tx, id, actor);
  return after;
}

/**
 * Unpair, with an audit entry each, every minor holiday paired with this one. The foreign key
 * would clear them on a delete by itself, but silently: "why is Christmas Eve no longer
 * paired?" needs an answer in the audit log.
 */
function unpairMinorsOf(tx: ShiftNurseTx, majorId: Id, actor: string): void {
  const paired = tx
    .select()
    .from(holidayTable)
    .where(eq(holidayTable.pairedHolidayId, majorId))
    .all()
    .map(toHoliday);
  for (const minor of paired) {
    tx.update(holidayTable)
      .set({ pairedHolidayId: null })
      .where(eq(holidayTable.id, minor.id))
      .run();
    recordAudit(tx, {
      entityType: 'holiday',
      entityId: minor.id,
      action: 'update',
      actor,
      before: minor,
      after: { ...minor, pairedHolidayId: null },
    });
  }
}

/** Delete a holiday, unpairing (and auditing) the minor holidays paired with it first. */
export function deleteHoliday(tx: ShiftNurseTx, id: Id, actor: string): void {
  const before = holidayOrThrow(tx, id);
  unpairMinorsOf(tx, id, actor);
  tx.delete(holidayTable).where(eq(holidayTable.id, id)).run();
  recordAudit(tx, { entityType: 'holiday', entityId: id, action: 'delete', actor, before });
}

/** Nurses with a worked (not standby) shift on `date` in a published or archived schedule. */
function workedFromSchedules(db: DbLike, unitId: Id, date: IsoDate): Id[] {
  const rows = db
    .selectDistinct({ nurseId: assignment.nurseId })
    .from(assignment)
    .innerJoin(schedulePeriod, eq(assignment.periodId, schedulePeriod.id))
    .innerJoin(shiftType, eq(assignment.shiftTypeId, shiftType.id))
    .where(
      and(
        eq(schedulePeriod.unitId, unitId),
        inArray(schedulePeriod.status, ['published', 'archived']),
        eq(assignment.date, date),
        eq(shiftType.isOnCall, false),
      ),
    )
    .all();
  return rows.map((r) => r.nurseId).sort();
}

function recordedWork(db: DbLike, holidayId: Id): Id[] {
  return db
    .select({ nurseId: holidayWork.nurseId })
    .from(holidayWork)
    .where(eq(holidayWork.holidayId, holidayId))
    .all()
    .map((r) => r.nurseId)
    .sort();
}

/**
 * Who worked each holiday dated in `[start, end]`: the recorded list where the manager has
 * set one, else what published schedules say.
 */
export function holidayWorkIn(
  db: DbLike,
  unitId: Id,
  start: IsoDate,
  end: IsoDate,
): HolidayWorkRecord[] {
  const rows = db
    .select()
    .from(holidayTable)
    .where(
      and(
        eq(holidayTable.unitId, unitId),
        gte(holidayTable.date, start),
        lte(holidayTable.date, end),
      ),
    )
    .all();
  return workFor(db, unitId, rows);
}

/** The same, for particular holidays: the far half of a pair, whenever it was. */
export function holidayWorkFor(
  db: DbLike,
  unitId: Id,
  holidayIds: readonly Id[],
): HolidayWorkRecord[] {
  if (holidayIds.length === 0) return [];
  const rows = db
    .select()
    .from(holidayTable)
    .where(and(eq(holidayTable.unitId, unitId), inArray(holidayTable.id, [...holidayIds])))
    .all();
  return workFor(db, unitId, rows);
}

function workFor(
  db: DbLike,
  unitId: Id,
  rows: readonly (typeof holidayTable.$inferSelect)[],
): HolidayWorkRecord[] {
  const out: HolidayWorkRecord[] = [];
  for (const row of [...rows].sort((a, b) => a.date.localeCompare(b.date))) {
    const nurseIds = row.workRecorded
      ? recordedWork(db, row.id)
      : workedFromSchedules(db, unitId, row.date as IsoDate);
    for (const nurseId of nurseIds) out.push({ holidayId: row.id, nurseId });
  }
  return out;
}

export interface HolidayWorkSummary {
  holidayId: Id;
  /** True when the list below was recorded by hand. */
  recorded: boolean;
  /** Who the rotation counts as having worked it. */
  nurseIds: Id[];
  /** What published schedules say, for comparison. */
  fromSchedules: Id[];
}

export function holidayWorkSummary(db: DbLike, holidayId: Id): HolidayWorkSummary {
  const row = db.select().from(holidayTable).where(eq(holidayTable.id, holidayId)).get();
  if (!row) throw new Error(`Holiday ${holidayId} not found`);
  const fromSchedules = workedFromSchedules(db, row.unitId, row.date as IsoDate);
  return {
    holidayId,
    recorded: row.workRecorded,
    nurseIds: row.workRecorded ? recordedWork(db, holidayId) : fromSchedules,
    fromSchedules,
  };
}

/** Record who worked a holiday by hand, replacing any earlier list. */
export function recordHolidayWork(
  tx: ShiftNurseTx,
  holidayId: Id,
  nurseIds: readonly Id[],
  actor: string,
): HolidayWorkSummary {
  const before = holidayWorkSummary(tx, holidayId);
  const unique = [...new Set(nurseIds)].sort();
  tx.delete(holidayWork).where(eq(holidayWork.holidayId, holidayId)).run();
  if (unique.length > 0) {
    tx.insert(holidayWork)
      .values(unique.map((nurseId) => ({ holidayId, nurseId })))
      .run();
  }
  tx.update(holidayTable).set({ workRecorded: true }).where(eq(holidayTable.id, holidayId)).run();
  const after = holidayWorkSummary(tx, holidayId);
  recordAudit(tx, {
    entityType: 'holiday_work',
    entityId: holidayId,
    action: 'update',
    actor,
    before,
    after,
  });
  return after;
}

/** Drop a recorded list, so the rotation goes back to what published schedules say. */
export function clearHolidayWork(
  tx: ShiftNurseTx,
  holidayId: Id,
  actor: string,
): HolidayWorkSummary {
  const before = holidayWorkSummary(tx, holidayId);
  tx.delete(holidayWork).where(eq(holidayWork.holidayId, holidayId)).run();
  tx.update(holidayTable).set({ workRecorded: false }).where(eq(holidayTable.id, holidayId)).run();
  const after = holidayWorkSummary(tx, holidayId);
  recordAudit(tx, {
    entityType: 'holiday_work',
    entityId: holidayId,
    action: 'update',
    actor,
    before,
    after,
  });
  return after;
}

/** A year of holidays as the manager approved it: `planHolidayYear`'s rows, edited. */
export interface HolidayYearInput {
  holidays: Pick<PlannedHoliday, 'key' | 'date' | 'name' | 'isMajor' | 'pairWith'>[];
  repairs: { minorId: Id; pairWith: PairTarget }[];
}

/**
 * Add a year of holidays in one go: majors first, so the minors (and last year's minors being
 * re-paired) can point at them. All or nothing — half a year of holidays with pairings pointing
 * at rows that failed to save would be worse than none.
 */
export function addHolidayYear(
  tx: ShiftNurseTx,
  unitId: Id,
  input: HolidayYearInput,
  actor: string,
): Holiday[] {
  const created = new Map<string, Holiday>();
  const resolve = (target: PairTarget, forName: string): Id => {
    if ('holidayId' in target) return target.holidayId;
    const row = created.get(target.key);
    if (!row) {
      throw new Error(`${forName} is paired with a holiday that is not being added`);
    }
    return row.id;
  };
  const ordered = [...input.holidays].sort((a, b) => Number(b.isMajor) - Number(a.isMajor));
  for (const row of ordered) {
    const holiday = createHoliday(
      tx,
      {
        unitId,
        date: row.date,
        name: row.name.trim(),
        isMajor: row.isMajor,
        pairedHolidayId:
          row.isMajor || row.pairWith === null ? null : resolve(row.pairWith, row.name),
      },
      actor,
    );
    created.set(row.key, holiday);
  }
  for (const repair of input.repairs) {
    const minor = holidayOrThrow(tx, repair.minorId);
    if (minor.pairedHolidayId !== null) continue;
    updateHoliday(tx, minor.id, { pairedHolidayId: resolve(repair.pairWith, minor.name) }, actor);
  }
  return [...created.values()].sort((a, b) => a.date.localeCompare(b.date));
}
