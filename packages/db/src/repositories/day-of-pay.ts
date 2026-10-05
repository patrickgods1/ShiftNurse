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

import type { DayOfPayEvent, Id, IsoDate } from '@shiftnurse/core';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import { nurse as nurseTable, nurseUnit, dayOfPayEvent as table } from '../schema.js';
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
  note?: string | null;
}

const PATCH_KEYS: PatchKeys<DayOfPayPatch> = { hoursWorked: true, note: true };

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
    checkHours(changes.hoursWorked, 'Hours worked');
    after.hoursWorked = changes.hoursWorked;
  }
  if ('note' in changes) {
    const note = changes.note?.trim();
    if (note) after.note = note;
    else delete after.note;
  }
  db.update(table)
    .set({ hoursWorked: after.hoursWorked ?? null, note: after.note ?? null })
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

function validate(db: DbLike, input: DayOfPayInput): void {
  const nurse = db.select().from(nurseTable).where(eq(nurseTable.id, input.nurseId)).get();
  if (!nurse) throw new Error('That nurse is not on the roster');
  const floatsHere =
    nurse.unitId !== input.unitId &&
    db
      .select({ id: nurseUnit.id })
      .from(nurseUnit)
      .where(and(eq(nurseUnit.nurseId, input.nurseId), eq(nurseUnit.unitId, input.unitId)))
      .get() !== undefined;
  if (nurse.unitId !== input.unitId && !floatsHere)
    throw new Error('That nurse is not on this unit');

  if (input.kind === 'missed_break') {
    if (input.break !== 'meal' && input.break !== 'rest') {
      throw new Error('Say whether the meal or the rest break was missed');
    }
    const same = listDayOfPayEvents(db, input.unitId, input.date, input.date).find(
      (e) => e.kind === 'missed_break' && e.nurseId === input.nurseId && e.break === input.break,
    );
    if (same) {
      throw new Error(
        `A missed ${input.break} break is already recorded for ${nurse.firstName} ${nurse.lastName} that day; the premium is one hour a day however many are missed`,
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
    return;
  }
  throw new Error(`Unknown day-of pay event kind ${String(input.kind)}`);
}
