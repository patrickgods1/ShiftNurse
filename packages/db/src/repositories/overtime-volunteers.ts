/**
 * Overtime volunteers: a nurse's recorded offer to work overtime over a date range.
 *
 * Where the law or contract bans mandatory overtime, `no-mandatory-overtime` accepts an overtime
 * shift only if one of these covers its date, so the record — and the note on how the offer was
 * made — is what the manager points to if the shift is disputed. Every write is audited with
 * `before` on update and delete for the same reason.
 */

import type { Id, IsoDate, OvertimeVolunteer } from '@shiftnurse/core';
import { compareDates } from '@shiftnurse/core';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import { toOvertimeVolunteer } from '../mappers.js';
import { nurse as nurseTable, overtimeVolunteer as table } from '../schema.js';
import { type PatchKeys, patchOf } from './patch.js';

const ENTITY = 'overtime_volunteer';

export type OvertimeVolunteerInput = Omit<OvertimeVolunteer, 'id'>;

/** The nurse and unit never change: to move an offer, delete it and record another. */
export interface OvertimeVolunteerPatch {
  startDate?: IsoDate;
  endDate?: IsoDate;
  /** `null` clears the note; an omitted key is left alone. */
  note?: string | null;
}

const PATCH_KEYS: PatchKeys<OvertimeVolunteerPatch> = {
  startDate: true,
  endDate: true,
  note: true,
};

export function listOvertimeVolunteers(db: DbLike, unitId: Id): OvertimeVolunteer[] {
  return db
    .select()
    .from(table)
    .where(eq(table.unitId, unitId))
    .orderBy(asc(table.startDate), asc(table.id))
    .all()
    .map(toOvertimeVolunteer);
}

/** Offers touching `[start, end]`, whole: an offer straddling the window keeps its full range. */
export function listOvertimeVolunteersOverlapping(
  db: DbLike,
  unitId: Id,
  start: IsoDate,
  end: IsoDate,
): OvertimeVolunteer[] {
  return db
    .select()
    .from(table)
    .where(and(eq(table.unitId, unitId), lte(table.startDate, end), gte(table.endDate, start)))
    .orderBy(asc(table.startDate), asc(table.id))
    .all()
    .map(toOvertimeVolunteer);
}

export function getOvertimeVolunteer(db: DbLike, id: Id): OvertimeVolunteer | undefined {
  const row = db.select().from(table).where(eq(table.id, id)).get();
  return row ? toOvertimeVolunteer(row) : undefined;
}

export function createOvertimeVolunteer(
  db: DbLike,
  input: OvertimeVolunteerInput,
  actor: string,
): OvertimeVolunteer {
  const note = input.note?.trim();
  const volunteer: OvertimeVolunteer = {
    id: ids.overtimeVolunteer(),
    unitId: input.unitId,
    nurseId: input.nurseId,
    startDate: input.startDate,
    endDate: input.endDate,
    ...(note ? { note } : {}),
  };
  validate(db, volunteer);
  db.insert(table)
    .values({ ...volunteer, note: volunteer.note ?? null, createdAt: Date.now() })
    .run();
  recordAudit(db, {
    entityType: ENTITY,
    entityId: volunteer.id,
    action: 'create',
    actor,
    after: volunteer,
  });
  return volunteer;
}

export function updateOvertimeVolunteer(
  db: DbLike,
  id: Id,
  patch: OvertimeVolunteerPatch,
  actor: string,
): OvertimeVolunteer {
  const before = getOvertimeVolunteer(db, id);
  if (!before) throw new Error(`Overtime volunteer ${id} not found`);
  const changes = patchOf(patch, PATCH_KEYS, 'overtime volunteer');
  const after: OvertimeVolunteer = { ...before };
  if (changes.startDate !== undefined) after.startDate = changes.startDate;
  if (changes.endDate !== undefined) after.endDate = changes.endDate;
  if (changes.note !== undefined) {
    const note = changes.note?.trim();
    if (note) after.note = note;
    else delete after.note;
  }
  validate(db, after);
  db.update(table)
    .set({
      startDate: after.startDate,
      endDate: after.endDate,
      note: after.note ?? null,
    })
    .where(eq(table.id, id))
    .run();
  recordAudit(db, { entityType: ENTITY, entityId: id, action: 'update', actor, before, after });
  return after;
}

export function deleteOvertimeVolunteer(db: DbLike, id: Id, actor: string): void {
  const before = getOvertimeVolunteer(db, id);
  if (!before) throw new Error(`Overtime volunteer ${id} not found`);
  db.delete(table).where(eq(table.id, id)).run();
  recordAudit(db, { entityType: ENTITY, entityId: id, action: 'delete', actor, before });
}

function validate(db: DbLike, volunteer: OvertimeVolunteer): void {
  if (compareDates(volunteer.endDate, volunteer.startDate) < 0) {
    throw new Error('The offer ends before it starts');
  }
  const row = db
    .select({ unitId: nurseTable.unitId })
    .from(nurseTable)
    .where(eq(nurseTable.id, volunteer.nurseId))
    .get();
  if (!row || row.unitId !== volunteer.unitId) {
    throw new Error('That nurse is not on this unit');
  }
}
