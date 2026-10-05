/**
 * Leave balances and FMLA certifications.
 *
 * Payroll owns the balance; the manager copies it in, with the date it was true on, so a request
 * can be checked against it (core's `checkLeaveBalance`). Setting one is an upsert audited as
 * create or update with its `before`, because "you had 40 hours when I approved that" is exactly
 * what gets argued over. A certification is the record behind an FMLA request: a range that runs
 * backwards, or a nurse who does not exist, would look like cover and prove nothing.
 */

import type { Id, IsoDate } from '@shiftnurse/core';
import { compareDates } from '@shiftnurse/core';
import { and, asc, eq } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import { leaveBalance as balanceTable, fmlaCertification as certTable, nurse } from '../schema.js';
import { type PatchKeys, patchOf } from './patch.js';

export type LeaveBalanceType = 'pto' | 'sick';

export interface LeaveBalance {
  id: Id;
  nurseId: Id;
  type: LeaveBalanceType;
  balanceHours: number;
  /** The payroll date the figure was true on. */
  asOf: IsoDate;
}

export interface FmlaCertification {
  id: Id;
  nurseId: Id;
  startDate: IsoDate;
  endDate: IsoDate;
  /** Leave may be taken in separate absences rather than one block. */
  intermittent: boolean;
  note?: string;
}

export type FmlaCertificationInput = Omit<FmlaCertification, 'id'>;

/** The nurse never changes: to move a certification, delete it and record another. */
export interface FmlaCertificationPatch {
  startDate?: IsoDate;
  endDate?: IsoDate;
  intermittent?: boolean;
  /** `null` clears the note; an omitted key is left alone. */
  note?: string | null;
}

const CERT_KEYS: PatchKeys<FmlaCertificationPatch> = {
  startDate: true,
  endDate: true,
  intermittent: true,
  note: true,
};

function toBalance(r: typeof balanceTable.$inferSelect): LeaveBalance {
  return {
    id: r.id,
    nurseId: r.nurseId,
    type: r.type,
    balanceHours: r.balanceHours,
    asOf: r.asOf,
  };
}

function toCertification(r: typeof certTable.$inferSelect): FmlaCertification {
  return {
    id: r.id,
    nurseId: r.nurseId,
    startDate: r.startDate,
    endDate: r.endDate,
    intermittent: r.intermittent,
    ...(r.note ? { note: r.note } : {}),
  };
}

function requireNurse(db: DbLike, nurseId: Id): void {
  if (!db.select({ id: nurse.id }).from(nurse).where(eq(nurse.id, nurseId)).get()) {
    throw new Error(`Nurse ${nurseId} not found`);
  }
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export function listLeaveBalancesForNurse(db: DbLike, nurseId: Id): LeaveBalance[] {
  return db
    .select()
    .from(balanceTable)
    .where(eq(balanceTable.nurseId, nurseId))
    .orderBy(asc(balanceTable.type))
    .all()
    .map(toBalance);
}

export function getLeaveBalance(
  db: DbLike,
  nurseId: Id,
  type: LeaveBalanceType,
): LeaveBalance | undefined {
  const row = db
    .select()
    .from(balanceTable)
    .where(and(eq(balanceTable.nurseId, nurseId), eq(balanceTable.type, type)))
    .get();
  return row ? toBalance(row) : undefined;
}

export function setLeaveBalance(
  db: DbLike,
  input: Omit<LeaveBalance, 'id'>,
  actor: string,
): LeaveBalance {
  if (input.type !== 'pto' && input.type !== 'sick') {
    throw new Error('Only PTO and sick balances are kept');
  }
  if (!Number.isFinite(input.balanceHours) || input.balanceHours < 0) {
    throw new Error('A balance is zero hours or more');
  }
  requireNurse(db, input.nurseId);
  const before = getLeaveBalance(db, input.nurseId, input.type);
  if (before) {
    const after: LeaveBalance = { ...before, balanceHours: input.balanceHours, asOf: input.asOf };
    db.update(balanceTable)
      .set({ balanceHours: after.balanceHours, asOf: after.asOf, updatedAt: Date.now() })
      .where(eq(balanceTable.id, before.id))
      .run();
    recordAudit(db, {
      entityType: 'leave_balance',
      entityId: before.id,
      action: 'update',
      actor,
      before,
      after,
    });
    return after;
  }
  const after: LeaveBalance = { id: ids.leaveBalance(), ...input };
  db.insert(balanceTable)
    .values({ ...after, updatedAt: Date.now() })
    .run();
  recordAudit(db, {
    entityType: 'leave_balance',
    entityId: after.id,
    action: 'create',
    actor,
    after,
  });
  return after;
}

// ---------------------------------------------------------------------------
// FMLA certifications
// ---------------------------------------------------------------------------

export function listFmlaCertifications(db: DbLike, nurseId: Id): FmlaCertification[] {
  return db
    .select()
    .from(certTable)
    .where(eq(certTable.nurseId, nurseId))
    .orderBy(asc(certTable.startDate), asc(certTable.id))
    .all()
    .map(toCertification);
}

export function getFmlaCertification(db: DbLike, id: Id): FmlaCertification | undefined {
  const row = db.select().from(certTable).where(eq(certTable.id, id)).get();
  return row ? toCertification(row) : undefined;
}

function validateCertification(c: FmlaCertification): void {
  if (compareDates(c.endDate, c.startDate) < 0) {
    throw new Error('The certification ends before it starts');
  }
}

export function createFmlaCertification(
  db: DbLike,
  input: FmlaCertificationInput,
  actor: string,
): FmlaCertification {
  requireNurse(db, input.nurseId);
  const note = input.note?.trim();
  const cert: FmlaCertification = {
    id: ids.fmlaCertification(),
    nurseId: input.nurseId,
    startDate: input.startDate,
    endDate: input.endDate,
    intermittent: input.intermittent,
    ...(note ? { note } : {}),
  };
  validateCertification(cert);
  db.insert(certTable)
    .values({ ...cert, note: cert.note ?? null, createdAt: Date.now() })
    .run();
  recordAudit(db, {
    entityType: 'fmla_certification',
    entityId: cert.id,
    action: 'create',
    actor,
    after: cert,
  });
  return cert;
}

export function updateFmlaCertification(
  db: DbLike,
  id: Id,
  patch: FmlaCertificationPatch,
  actor: string,
): FmlaCertification {
  const before = getFmlaCertification(db, id);
  if (!before) throw new Error(`FMLA certification ${id} not found`);
  const changes = patchOf(patch, CERT_KEYS, 'FMLA certification');
  const after: FmlaCertification = { ...before };
  if (changes.startDate !== undefined) after.startDate = changes.startDate;
  if (changes.endDate !== undefined) after.endDate = changes.endDate;
  if (changes.intermittent !== undefined) after.intermittent = changes.intermittent;
  if (changes.note !== undefined) {
    const note = changes.note?.trim();
    if (note) after.note = note;
    else delete after.note;
  }
  validateCertification(after);
  db.update(certTable)
    .set({
      startDate: after.startDate,
      endDate: after.endDate,
      intermittent: after.intermittent,
      note: after.note ?? null,
    })
    .where(eq(certTable.id, id))
    .run();
  recordAudit(db, {
    entityType: 'fmla_certification',
    entityId: id,
    action: 'update',
    actor,
    before,
    after,
  });
  return after;
}

export function deleteFmlaCertification(db: DbLike, id: Id, actor: string): void {
  const before = getFmlaCertification(db, id);
  if (!before) throw new Error(`FMLA certification ${id} not found`);
  db.delete(certTable).where(eq(certTable.id, id)).run();
  recordAudit(db, {
    entityType: 'fmla_certification',
    entityId: id,
    action: 'delete',
    actor,
    before,
  });
}
