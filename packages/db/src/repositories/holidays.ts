/**
 * Holidays beyond the calendar itself: moving one between major and minor, pairing a minor
 * holiday with a major one, and who worked each past holiday — the history the holiday rotation
 * reads (`@shiftnurse/core`'s `holiday-rotation.ts`).
 *
 * Who worked a holiday comes from published schedules unless the manager has recorded it by
 * hand, which is how a unit starts the rotation with a year that predates the app, or corrects
 * a schedule that did not match who came in. A recorded list is authoritative even when empty:
 * "nobody on today's roster worked it" is an answer, not a gap. Only nurses of the unit (home, or
 * floated there that day) can be recorded, and a holiday with a recorded list cannot be deleted
 * until the list is cleared: the list is the rotation's only source for a year before the app,
 * and the foreign keys would cascade it away without a trace.
 * A holiday's date can be changed (the recorded list stays with it), with a reason when a published
 * or archived schedule covers either date.
 */

import {
  addDays,
  attributedHolidayDates,
  dateInRange,
  type Holiday,
  type HolidayWorkRecord,
  type Id,
  type IsoDate,
  type PairTarget,
  type PlannedHoliday,
} from '@shiftnurse/core';
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { recordAudit, recordAuditStrict } from '../audit.js';
import type { DbLike, ShiftNurseTx } from '../client.js';
import { ids } from '../ids.js';
import { toHoliday } from '../mappers.js';
import {
  assignment,
  holiday as holidayTable,
  holidayWork,
  nurse as nurseTable,
  preference as preferenceTable,
  schedulePeriod,
  shiftType,
  unit as unitTable,
} from '../schema.js';
import { listHolidaysForUnit } from './config.js';
import { nurseWorksOnUnit } from './nurse-units.js';
import { type PatchKeys, patchOf } from './patch.js';
import { unitForPeriod } from './period-unit.js';
import { listPreferencesForNurse } from './roster.js';
import { listPeriodsForUnit } from './schedule.js';

export interface HolidayPatch {
  /** A different day for the same holiday; `unitId` stays fixed. */
  date?: IsoDate;
  name?: string;
  isMajor?: boolean;
  pairedHolidayId?: Id | null;
}

const HOLIDAY_PATCH_KEYS: PatchKeys<HolidayPatch> = {
  date: true,
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
 *
 * A holiday can also move to another date. Published holiday pay is held by each period's pay
 * snapshot, but the rotation's who-worked list is read from published schedules by date, so a move
 * that a published or archived period covers (old or new date) needs a stated reason.
 */
export function updateHoliday(
  tx: ShiftNurseTx,
  id: Id,
  patch: HolidayPatch,
  actor: string,
  reason?: string,
): Holiday {
  const before = holidayOrThrow(tx, id);
  const merged: Holiday = { ...before, ...patchOf(patch, HOLIDAY_PATCH_KEYS, 'holiday') };
  if (merged.name.trim() === '') throw new Error('A holiday needs a name');
  const after: Holiday = merged.isMajor ? { ...merged, pairedHolidayId: null } : merged;
  assertHolidayPairing(tx, after);

  // Checked in words before any write, so the manager never meets the unique index.
  let covered = false;
  if (after.date !== before.date) {
    const other = listHolidaysForUnit(tx, before.unitId).find(
      (h) => h.id !== id && h.date === after.date,
    );
    if (other) {
      throw new Error(`${other.name} is already on ${after.date}; a unit keeps one holiday a day.`);
    }
    const periods = listPeriodsForUnit(tx, before.unitId)
      .filter((p) => p.status === 'published' || p.status === 'archived')
      .filter(
        (p) =>
          dateInRange(before.date, p.startDate, p.endDate) ||
          dateInRange(after.date, p.startDate, p.endDate),
      )
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
    covered = periods.length > 0;
    if (covered && (reason === undefined || reason.trim() === '')) {
      const many = periods.length > 1;
      throw new Error(
        `Moving ${before.name} from ${before.date} to ${after.date} needs a reason: ${periods.map((p) => p.name).join(', ')} ${many ? 'are' : 'is'} published, and the holiday rotation counts who worked ${before.name} from ${many ? 'them' : 'it'}.`,
      );
    }
  }

  tx.update(holidayTable)
    .set({
      date: after.date,
      name: after.name,
      isMajor: after.isMajor,
      pairedHolidayId: after.pairedHolidayId,
    })
    .where(eq(holidayTable.id, id))
    .run();
  const audit = {
    entityType: 'holiday' as const,
    entityId: id,
    action: 'update' as const,
    actor,
    before,
    after,
  };
  if (covered) {
    recordAuditStrict(tx, { ...audit, reason: reason?.trim() }, { requireReason: true });
  } else {
    recordAudit(tx, reason?.trim() ? { ...audit, reason: reason.trim() } : audit);
  }

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

/**
 * Delete a holiday, unpairing (and auditing) the minor holidays paired with it first. Refused
 * while a hand-recorded who-worked list exists, even an empty one; the nurses' wishes to work it
 * are removed explicitly, one audit row each, instead of by the foreign key's silent cascade.
 */
export function deleteHoliday(tx: ShiftNurseTx, id: Id, actor: string): void {
  const row = tx.select().from(holidayTable).where(eq(holidayTable.id, id)).get();
  if (!row) throw new Error(`Holiday ${id} not found`);
  const before = toHoliday(row);
  if (row.workRecorded) {
    throw new Error(
      `Who worked ${before.name} on ${before.date} is recorded by hand, and next year's rotation reads that list. Clear the recorded list first (it stays in the audit log), then delete the holiday.`,
    );
  }
  unpairMinorsOf(tx, id, actor);
  const wishers = tx
    .selectDistinct({ nurseId: preferenceTable.nurseId })
    .from(preferenceTable)
    .where(and(eq(preferenceTable.kind, 'holiday_appetite'), eq(preferenceTable.holidayId, id)))
    .all()
    .map((r) => r.nurseId)
    .sort();
  for (const nurseId of wishers) {
    const prefsBefore = listPreferencesForNurse(tx, nurseId);
    tx.delete(preferenceTable)
      .where(
        and(
          eq(preferenceTable.nurseId, nurseId),
          eq(preferenceTable.kind, 'holiday_appetite'),
          eq(preferenceTable.holidayId, id),
        ),
      )
      .run();
    recordAudit(tx, {
      entityType: 'preference',
      entityId: nurseId,
      action: 'update',
      actor,
      before: prefsBefore,
      after: listPreferencesForNurse(tx, nurseId),
    });
  }
  tx.delete(holidayTable).where(eq(holidayTable.id, id)).run();
  recordAudit(tx, { entityType: 'holiday', entityId: id, action: 'delete', actor, before });
}

/**
 * Nurses with a worked (not standby) shift that counts for `date` in a published or archived
 * schedule, by the unit's holiday attribution (D18): a shift dated the day before can run into it.
 * The attribution is the one the schedule holding `date` went out under, so switching the unit to
 * the clock reading does not change who worked last Christmas; with no such schedule, the unit's.
 */
function workedFromSchedules(db: DbLike, unitId: Id, date: IsoDate): Id[] {
  const covering = listPeriodsForUnit(db, unitId)
    .filter((p) => p.status !== 'draft' && dateInRange(date, p.startDate, p.endDate))
    .sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
  const attribution =
    (covering
      ? unitForPeriod(db, covering).holidayAttribution
      : db
          .select({ holidayAttribution: unitTable.holidayAttribution })
          .from(unitTable)
          .where(eq(unitTable.id, unitId))
          .get()?.holidayAttribution) ?? 'start';
  const rows = db
    .select({
      nurseId: assignment.nurseId,
      date: assignment.date,
      startTime: shiftType.startTime,
      durationHours: shiftType.durationHours,
    })
    .from(assignment)
    .innerJoin(schedulePeriod, eq(assignment.periodId, schedulePeriod.id))
    .innerJoin(shiftType, eq(assignment.shiftTypeId, shiftType.id))
    .where(
      and(
        eq(schedulePeriod.unitId, unitId),
        inArray(schedulePeriod.status, ['published', 'archived']),
        // The day before only matters when a shift can run into `date`.
        inArray(assignment.date, attribution === 'start' ? [date] : [addDays(date, -1), date]),
        eq(shiftType.isOnCall, false),
      ),
    )
    .all();
  const nurseIds = new Set<Id>();
  for (const r of rows) {
    const counts = attributedHolidayDates(r.date as IsoDate, r, attribution, (d) => d === date);
    if (counts.includes(date)) nurseIds.add(r.nurseId);
  }
  return [...nurseIds].sort();
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

/**
 * Refuse anyone who was not on the holiday's unit that day. A nurse who has since left still
 * counts (they may have worked a past holiday); a float counts only inside their membership.
 */
function requireHolidayWorkers(tx: ShiftNurseTx, holiday: Holiday, ids: readonly Id[]): void {
  if (ids.length === 0) return;
  const rows = tx
    .select()
    .from(nurseTable)
    .where(inArray(nurseTable.id, [...ids]))
    .all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (ids.some((id) => !byId.has(id))) {
    throw new Error(
      'One of the nurses chosen is no longer on the roster. Reopen the list and choose again.',
    );
  }
  for (const id of ids) {
    const n = byId.get(id)!;
    if (nurseWorksOnUnit(tx, id, holiday.unitId, { start: holiday.date, end: holiday.date })) {
      continue;
    }
    const unitName = tx
      .select({ name: unitTable.name })
      .from(unitTable)
      .where(eq(unitTable.id, holiday.unitId))
      .get()?.name;
    if (unitName === undefined) throw new Error(`Unit ${holiday.unitId} not found`);
    throw new Error(
      `${n.firstName} ${n.lastName} was not on ${unitName}'s roster on ${holiday.date}, so cannot be recorded as working ${holiday.name}.`,
    );
  }
}

/** Record who worked a holiday by hand, replacing any earlier list. */
export function recordHolidayWork(
  tx: ShiftNurseTx,
  holidayId: Id,
  nurseIds: readonly Id[],
  actor: string,
): HolidayWorkSummary {
  const holiday = holidayOrThrow(tx, holidayId);
  const before = holidayWorkSummary(tx, holidayId);
  const unique = [...new Set(nurseIds)].sort();
  requireHolidayWorkers(tx, holiday, unique);
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
    before: { date: holiday.date, ...before },
    after: { date: holiday.date, ...after },
  });
  return after;
}

/** Drop a recorded list, so the rotation goes back to what published schedules say. */
export function clearHolidayWork(
  tx: ShiftNurseTx,
  holidayId: Id,
  actor: string,
): HolidayWorkSummary {
  const holiday = holidayOrThrow(tx, holidayId);
  const before = holidayWorkSummary(tx, holidayId);
  tx.delete(holidayWork).where(eq(holidayWork.holidayId, holidayId)).run();
  tx.update(holidayTable).set({ workRecorded: false }).where(eq(holidayTable.id, holidayId)).run();
  const after = holidayWorkSummary(tx, holidayId);
  recordAudit(tx, {
    entityType: 'holiday_work',
    entityId: holidayId,
    action: 'update',
    actor,
    before: { date: holiday.date, ...before },
    after: { date: holiday.date, ...after },
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
