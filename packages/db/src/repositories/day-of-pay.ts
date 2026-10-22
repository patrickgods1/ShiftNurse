/**
 * The day's pay events: missed breaks, nurses sent home on arrival, standby nurses called back.
 *
 * None is an assignment, so the schedule's cost never sees them; they are recorded here by the
 * day-of console and priced by core's `priceDayOfEvents` beside it. A row is refused when it would
 * be paid twice by mistake (a second missed meal for the same nurse and day, a second send-home
 * from the same shift) and when its hours cannot be a real shift's, because a typo of 80 for 8
 * would otherwise price an eighty-hour call-back. Every change is audited with its `before`; the
 * rows carry the nurse's id as `nurseId`, which is how a grievance export finds them.
 */

import {
  addDays,
  type CallBack,
  callBackWindow,
  type DayOfPayEvent,
  describeDate,
  formatTimeOfDay,
  hoursToMinutes,
  type Id,
  type IsoDate,
  shiftWindow,
  windowsOverlap,
} from '@shiftnurse/core';
import { and, asc, eq, gte, inArray, isNotNull, lte, notExists, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import {
  assignment,
  callOff,
  nurse as nurseTable,
  schedulePeriod,
  shiftType,
  dayOfPayEvent as table,
  unit as unitTable,
} from '../schema.js';
import { requireWorksOnUnit } from './nurse-units.js';
import { type PatchKeys, patchOf } from './patch.js';

const ENTITY = 'day_of_pay_event';

export type DayOfPayKind = 'missed_break' | 'sent_home' | 'call_back';

export interface DayOfPayRecord {
  id: Id;
  unitId: Id;
  nurseId: Id;
  kind: DayOfPayKind;
  date: IsoDate;
  shiftTypeId?: Id;
  /** Missed breaks only. */
  break?: 'meal' | 'rest';
  /** Sent home: the shift's paid length. */
  scheduledHours?: number;
  /** Sent home and call-back: the hours actually worked. */
  hoursWorked?: number;
  /**
   * Call-back only: minutes from the start of the standby shift (`date`, `shiftTypeId`) to when
   * the nurse started working. Required on a new call-back; an older row without it is pay-only.
   */
  startMinute?: number;
  note?: string;
  /** 'manager' in v1; 'nurse' once self-service ships. Never inferred at read time. */
  enteredBy: 'manager' | 'nurse';
  createdAt: number;
}

export type DayOfPayInput = Omit<DayOfPayRecord, 'id' | 'createdAt' | 'enteredBy'> & {
  enteredBy?: DayOfPayRecord['enteredBy'];
};

/** What is known only later: the hours a nurse actually worked, and the note. */
export interface DayOfPayPatch {
  hoursWorked?: number;
  startMinute?: number;
  note?: string | null;
}

const PATCH_KEYS: PatchKeys<DayOfPayPatch> = { hoursWorked: true, startMinute: true, note: true };

function toRecord(r: typeof table.$inferSelect): DayOfPayRecord {
  return {
    id: r.id,
    unitId: r.unitId,
    nurseId: r.nurseId,
    kind: r.kind,
    date: r.date,
    ...(r.shiftTypeId ? { shiftTypeId: r.shiftTypeId } : {}),
    ...(r.breakKind ? { break: r.breakKind } : {}),
    ...(r.scheduledHours !== null ? { scheduledHours: r.scheduledHours } : {}),
    ...(r.hoursWorked !== null ? { hoursWorked: r.hoursWorked } : {}),
    ...(r.startMinute !== null ? { startMinute: r.startMinute } : {}),
    ...(r.note ? { note: r.note } : {}),
    enteredBy: r.enteredBy,
    createdAt: r.createdAt,
  };
}

/** Events dated in `[start, end]` (inclusive), by date and then the order they were recorded. */
export function listDayOfPayEvents(
  db: DbLike,
  unitId: Id,
  start: IsoDate,
  end: IsoDate,
): DayOfPayRecord[] {
  return db
    .select()
    .from(table)
    .where(and(eq(table.unitId, unitId), gte(table.date, start), lte(table.date, end)))
    .orderBy(asc(table.date), sql`${table}.rowid`)
    .all()
    .map(toRecord);
}

/**
 * The nurse's day-of pay events on `date`, on any unit, with the unit's name. A missed-break
 * premium is one hour per workday, so the duplicate check cannot stop at the unit being recorded
 * on: a nurse who worked two units that day would otherwise be paid it twice.
 */
export function dayOfPayEventsForNurseOn(
  db: DbLike,
  nurseId: Id,
  date: IsoDate,
): { event: DayOfPayRecord; unitName: string }[] {
  return db
    .select({ row: table, unitName: unitTable.name })
    .from(table)
    .innerJoin(unitTable, eq(table.unitId, unitTable.id))
    .where(and(eq(table.nurseId, nurseId), eq(table.date, date)))
    .orderBy(asc(unitTable.name), asc(table.id))
    .all()
    .map((r) => ({ event: toRecord(r.row), unitName: r.unitName }));
}

export function getDayOfPayEvent(db: DbLike, id: Id): DayOfPayRecord | undefined {
  const row = db.select().from(table).where(eq(table.id, id)).get();
  return row ? toRecord(row) : undefined;
}

function toEvent(r: DayOfPayRecord): DayOfPayEvent {
  const { nurseId, date } = r;
  switch (r.kind) {
    case 'missed_break':
      if (!r.break) throw new Error(`Missed break ${r.id} has no break kind`);
      return { kind: 'missed_break', nurseId, date, break: r.break };
    case 'sent_home':
      return {
        kind: 'sent_home',
        nurseId,
        date,
        scheduledHours: r.scheduledHours ?? 0,
        hoursWorked: r.hoursWorked ?? 0,
      };
    case 'call_back':
      return { kind: 'call_back', nurseId, date, hoursWorked: r.hoursWorked ?? 0 };
  }
}

/** The records as the events core prices; an event missing what its kind needs is a bug, loud. */
export function dayOfPayEventsOf(records: readonly DayOfPayRecord[]): DayOfPayEvent[] {
  return records.map(toEvent);
}

export function createDayOfPayEvent(
  db: DbLike,
  input: DayOfPayInput,
  actor: string,
): DayOfPayRecord {
  validate(db, input);
  const note = input.note?.trim();
  const record: DayOfPayRecord = {
    id: ids.dayOfPayEvent(),
    unitId: input.unitId,
    nurseId: input.nurseId,
    kind: input.kind,
    date: input.date,
    ...(input.shiftTypeId ? { shiftTypeId: input.shiftTypeId } : {}),
    ...(input.kind === 'missed_break' && input.break ? { break: input.break } : {}),
    ...(input.kind === 'sent_home' ? { scheduledHours: input.scheduledHours } : {}),
    ...(input.kind !== 'missed_break' ? { hoursWorked: input.hoursWorked ?? 0 } : {}),
    ...(input.kind === 'call_back' && input.startMinute !== undefined
      ? { startMinute: input.startMinute }
      : {}),
    ...(note ? { note } : {}),
    enteredBy: input.enteredBy ?? 'manager',
    createdAt: Date.now(),
  };
  db.insert(table)
    .values({
      id: record.id,
      unitId: record.unitId,
      nurseId: record.nurseId,
      kind: record.kind,
      date: record.date,
      shiftTypeId: record.shiftTypeId ?? null,
      breakKind: record.break ?? null,
      scheduledHours: record.scheduledHours ?? null,
      hoursWorked: record.hoursWorked ?? null,
      startMinute: record.startMinute ?? null,
      note: record.note ?? null,
      enteredBy: record.enteredBy,
      createdAt: record.createdAt,
    })
    .run();
  recordAudit(db, {
    entityType: ENTITY,
    entityId: record.id,
    action: 'create',
    actor,
    after: record,
  });
  return record;
}

export function updateDayOfPayEvent(
  db: DbLike,
  id: Id,
  patch: DayOfPayPatch,
  actor: string,
): DayOfPayRecord {
  const before = getDayOfPayEvent(db, id);
  if (!before) throw new Error(`Day-of pay event ${id} not found`);
  const changes = patchOf(patch, PATCH_KEYS, 'day-of pay event');
  const after: DayOfPayRecord = { ...before };
  if (changes.hoursWorked !== undefined) {
    if (before.kind === 'missed_break') {
      throw new Error('A missed break has no hours to change');
    }
    if (before.kind === 'call_back' && !(changes.hoursWorked > 0)) {
      throw new Error('Enter the hours the call-back worked');
    }
    checkHours(changes.hoursWorked, 'Hours worked');
    if (before.kind === 'sent_home') checkWithinShift(changes.hoursWorked, before.scheduledHours);
    after.hoursWorked = changes.hoursWorked;
  }
  if (changes.startMinute !== undefined) {
    if (before.kind !== 'call_back') throw new Error('Only a call-back has a start time');
    after.startMinute = changes.startMinute;
  }
  // An old pay-only call-back stays valid while its time is left alone; once it has a time, a new
  // length must still fit between the nurse's worked shifts.
  // A note-only edit must not re-judge a call-back against shifts published after it was recorded.
  const timingChanged = changes.startMinute !== undefined || changes.hoursWorked !== undefined;
  if (timingChanged && after.kind === 'call_back' && after.startMinute !== undefined) {
    checkCallBackTime(db, after);
  }
  if ('note' in changes) {
    const note = changes.note?.trim();
    if (note) after.note = note;
    else delete after.note;
  }
  db.update(table)
    .set({
      hoursWorked: after.hoursWorked ?? null,
      startMinute: after.startMinute ?? null,
      note: after.note ?? null,
    })
    .where(eq(table.id, id))
    .run();
  recordAudit(db, { entityType: ENTITY, entityId: id, action: 'update', actor, before, after });
  return after;
}

export function deleteDayOfPayEvent(db: DbLike, id: Id, actor: string): void {
  const before = getDayOfPayEvent(db, id);
  if (!before) throw new Error(`Day-of pay event ${id} not found`);
  db.delete(table).where(eq(table.id, id)).run();
  recordAudit(db, { entityType: ENTITY, entityId: id, action: 'delete', actor, before });
}

function checkHours(hours: number, label: string): void {
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) {
    throw new Error(`${label} must be between 0 and 24`);
  }
}

/** Someone who worked past the shift was not sent home; equal hours are left to the manager. */
function checkWithinShift(worked: number, scheduled: number | undefined): void {
  if (scheduled !== undefined && worked > scheduled) {
    throw new Error(
      `Hours worked (${worked}) cannot be more than the ${scheduled} scheduled; a nurse who worked past the shift was not sent home.`,
    );
  }
}

function validate(db: DbLike, input: DayOfPayInput): void {
  const nurse = db.select().from(nurseTable).where(eq(nurseTable.id, input.nurseId)).get();
  if (!nurse) throw new Error('That nurse is not on the roster');
  requireWorksOnUnit(db, input.nurseId, input.unitId, { start: input.date, end: input.date });

  if (input.kind === 'missed_break') {
    if (input.break !== 'meal' && input.break !== 'rest') {
      throw new Error('Say whether the meal or the rest break was missed');
    }
    const same = dayOfPayEventsForNurseOn(db, input.nurseId, input.date).find(
      (e) => e.event.kind === 'missed_break' && e.event.break === input.break,
    );
    if (same) {
      throw new Error(
        `A missed ${input.break} break is already recorded for ${nurse.firstName} ${nurse.lastName} that day on ${same.unitName}; the premium is one hour a day however many are missed`,
      );
    }
    return;
  }
  if (input.kind === 'sent_home') {
    const scheduled = input.scheduledHours;
    if (scheduled === undefined || !(scheduled > 0) || scheduled > 24) {
      throw new Error('The scheduled hours must be more than 0 and at most 24');
    }
    checkHours(input.hoursWorked ?? 0, 'Hours worked');
    checkWithinShift(input.hoursWorked ?? 0, scheduled);
    const same = listDayOfPayEvents(db, input.unitId, input.date, input.date).find(
      (e) =>
        e.kind === 'sent_home' &&
        e.nurseId === input.nurseId &&
        e.shiftTypeId === (input.shiftTypeId ?? undefined),
    );
    if (same) {
      throw new Error(
        `${nurse.firstName} ${nurse.lastName} is already recorded as sent home from that shift`,
      );
    }
    return;
  }
  if (input.kind === 'call_back') {
    const worked = input.hoursWorked;
    if (worked === undefined || !(worked > 0)) {
      throw new Error('Enter the hours the call-back worked');
    }
    checkHours(worked, 'Hours worked');
    if (input.startMinute === undefined) throw new Error('Enter the time the call-back started.');
    checkCallBackTime(db, input);
    return;
  }
  throw new Error(`Unknown day-of pay event kind ${String(input.kind)}`);
}

/**
 * A call-back starts inside its standby shift and does not run over a shift the nurse works. The
 * standby's declared length bounds the start; its window is placed by core, never by subtracting
 * timestamps. A worked shift that she called off from and nobody covered is not work, as in
 * `workedShiftsForNurseInRange`.
 */
function checkCallBackTime(
  db: DbLike,
  cb: Pick<DayOfPayInput, 'nurseId' | 'date' | 'shiftTypeId' | 'startMinute' | 'hoursWorked'>,
): void {
  if (!cb.shiftTypeId) throw new Error('Say which on-call shift the nurse was called back from');
  const standby = db.select().from(shiftType).where(eq(shiftType.id, cb.shiftTypeId)).get();
  if (!standby) throw new Error('That on-call shift does not exist');
  if (!standby.isOnCall) throw new Error(`${standby.name} is not an on-call shift`);
  const standbyWindow = shiftWindow(cb.date, standby);
  const start = cb.startMinute ?? 0;
  if (!Number.isInteger(start) || start < 0 || start >= hoursToMinutes(standby.durationHours)) {
    const endClock = formatTimeOfDay(standbyWindow.endMinute % 1440);
    throw new Error(
      `The call-back must start during the on-call shift (${standby.startTime}–${endClock}).`,
    );
  }
  const window = {
    startMinute: standbyWindow.startMinute + start,
    endMinute: standbyWindow.startMinute + start + hoursToMinutes(cb.hoursWorked ?? 0),
  };
  // Two days either side covers a shift that started the day before and a 24-hour one.
  const others = db
    .select({ date: assignment.date, type: shiftType, firstName: nurseTable.firstName })
    .from(assignment)
    .innerJoin(shiftType, eq(assignment.shiftTypeId, shiftType.id))
    .innerJoin(schedulePeriod, eq(assignment.periodId, schedulePeriod.id))
    .innerJoin(nurseTable, eq(assignment.nurseId, nurseTable.id))
    .where(
      and(
        eq(assignment.nurseId, cb.nurseId),
        eq(shiftType.isOnCall, false),
        inArray(schedulePeriod.status, ['published', 'archived']),
        gte(assignment.date, addDays(cb.date, -2)),
        lte(assignment.date, addDays(cb.date, 2)),
        notExists(
          db
            .select({ one: callOff.id })
            .from(callOff)
            .where(
              and(
                eq(callOff.assignmentId, assignment.id),
                inArray(callOff.status, ['open', 'uncovered']),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(assignment.date), asc(assignment.id))
    .all();
  const clash = others.find((o) => windowsOverlap(window, shiftWindow(o.date as IsoDate, o.type)));
  if (clash) {
    throw new Error(
      `The call-back overlaps ${clash.firstName}'s ${clash.type.name} on ${describeDate(clash.date as IsoDate)}.`,
    );
  }
}

/**
 * These nurses' timed call-backs dated (by their standby) in `[start, end]`, on any unit: worked
 * time the hour caps count wherever it was worked, as core's `CallBack`. Each window is placed from
 * the standby's shift type by core, never by subtracting timestamps. Older pay-only rows (no start
 * time) are left out: there is no telling when those hours fell.
 */
export function callBacksForNurses(
  db: DbLike,
  nurseIds: readonly Id[],
  start: IsoDate,
  end: IsoDate,
): CallBack[] {
  if (nurseIds.length === 0) return [];
  return (
    db
      .select({ row: table, standby: shiftType })
      .from(table)
      .innerJoin(shiftType, eq(table.shiftTypeId, shiftType.id))
      .where(
        and(
          eq(table.kind, 'call_back'),
          isNotNull(table.startMinute),
          inArray(table.nurseId, [...nurseIds]),
          gte(table.date, start),
          lte(table.date, end),
        ),
      )
      .orderBy(asc(table.date), asc(table.nurseId), sql`${table}.rowid`)
      .all()
      // A call-back of no hours covers no time on the clock.
      .filter((r) => (r.row.hoursWorked ?? 0) > 0)
      .map((r) => ({
        nurseId: r.row.nurseId,
        window: callBackWindow(r.row.date, r.standby, r.row.startMinute!, r.row.hoursWorked!),
      }))
  );
}
