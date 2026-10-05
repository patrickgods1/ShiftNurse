/**
 * Low-census cancellation: the unit's order of who goes home first, and the record of each nurse
 * actually sent home.
 *
 * The rotation tier of core's `cancellationOrder` is only fair if it can see who was cancelled
 * before, so every cancellation is a row of its own — and the row outlives the assignment it
 * removed, which is why it carries the shift's identity rather than a foreign key. The stated
 * reason is the order's words for the place the nurse held ("Rotation: no low-census
 * cancellations yet…"), kept verbatim because it is what answers "why me?".
 */

import {
  addDays,
  type CancellationHistory,
  type CancellationTier,
  compareDates,
  DEFAULT_CANCELLATION_TIERS,
  type Id,
  type IsoDate,
} from '@shiftnurse/core';
import { and, asc, eq, gte } from 'drizzle-orm';
import { recordAudit, recordAuditStrict } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import {
  cancellationPolicy,
  nurse as nurseTable,
  schedulePeriod,
  shiftCancellation as table,
} from '../schema.js';

const POLICY = 'cancellation_policy';
const ENTITY = 'shift_cancellation';

/** How far back the rotation looks: a year of cancellations, as the contracts count it. */
export const CANCELLATION_HISTORY_DAYS = 365;

export interface ShiftCancellation {
  id: Id;
  periodId: Id;
  nurseId: Id;
  shiftTypeId: Id;
  date: IsoDate;
  reason: string;
  cancelledAt: number;
  /** 'manager' in v1; 'nurse' once self-service ships. Never inferred at read time. */
  enteredBy: 'manager' | 'nurse';
}

export type ShiftCancellationInput = Omit<ShiftCancellation, 'id' | 'cancelledAt' | 'enteredBy'> & {
  enteredBy?: ShiftCancellation['enteredBy'];
};

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** A unit with no saved policy gets the contract's usual order. */
export function getCancellationPolicy(db: DbLike, unitId: Id): CancellationTier[] {
  const row = db
    .select()
    .from(cancellationPolicy)
    .where(eq(cancellationPolicy.unitId, unitId))
    .get();
  return row ? [...row.tiers] : [...DEFAULT_CANCELLATION_TIERS];
}

export function saveCancellationPolicy(
  db: DbLike,
  unitId: Id,
  tiers: readonly CancellationTier[],
  actor: string,
): CancellationTier[] {
  // IPC input is typed, not checked: a tier name outside the set would silently cancel nobody.
  const unknown = tiers.find((t) => !DEFAULT_CANCELLATION_TIERS.includes(t));
  if (unknown !== undefined) throw new Error(`"${unknown}" is not a cancellation tier`);
  if (new Set(tiers).size !== tiers.length) {
    throw new Error('Each tier can appear only once in the cancellation order');
  }
  if (tiers.length === 0) {
    throw new Error('Keep at least one tier in the cancellation order, or nobody can be cancelled');
  }
  const after = [...tiers];
  const row = db
    .select()
    .from(cancellationPolicy)
    .where(eq(cancellationPolicy.unitId, unitId))
    .get();
  if (row) {
    const before = [...row.tiers];
    db.update(cancellationPolicy)
      .set({ tiers: after })
      .where(eq(cancellationPolicy.id, row.id))
      .run();
    recordAudit(db, {
      entityType: POLICY,
      entityId: row.id,
      action: 'update',
      actor,
      before: { tiers: before },
      after: { tiers: after },
    });
    return after;
  }
  const id = ids.cancellationPolicy();
  db.insert(cancellationPolicy).values({ id, unitId, tiers: after }).run();
  recordAudit(db, {
    entityType: POLICY,
    entityId: id,
    action: 'create',
    actor,
    after: { tiers: after },
  });
  return after;
}

// ---------------------------------------------------------------------------
// Cancellations
// ---------------------------------------------------------------------------

function toCancellation(r: typeof table.$inferSelect): ShiftCancellation {
  return {
    id: r.id,
    periodId: r.periodId,
    nurseId: r.nurseId,
    shiftTypeId: r.shiftTypeId,
    date: r.date,
    reason: r.reason,
    cancelledAt: r.cancelledAt,
    enteredBy: r.enteredBy,
  };
}

export function listShiftCancellationsForPeriod(db: DbLike, periodId: Id): ShiftCancellation[] {
  return db
    .select()
    .from(table)
    .where(eq(table.periodId, periodId))
    .orderBy(asc(table.date), asc(table.cancelledAt), asc(table.id))
    .all()
    .map(toCancellation);
}

/**
 * Record that a nurse was sent home. The caller removes the assignment in the same transaction;
 * this writes only the event and its audit entry, and refuses without a reason because that
 * text is what gets quoted if the cancellation is challenged.
 */
export function recordShiftCancellation(
  db: DbLike,
  input: ShiftCancellationInput,
  actor: string,
): ShiftCancellation {
  const reason = input.reason.trim();
  if (!reason) throw new Error('A cancellation needs a stated reason');
  const period = db
    .select({ unitId: schedulePeriod.unitId })
    .from(schedulePeriod)
    .where(eq(schedulePeriod.id, input.periodId))
    .get();
  if (!period) throw new Error(`Period ${input.periodId} not found`);
  const nurse = db
    .select({ unitId: nurseTable.unitId })
    .from(nurseTable)
    .where(eq(nurseTable.id, input.nurseId))
    .get();
  if (!nurse || nurse.unitId !== period.unitId) throw new Error('That nurse is not on this unit');

  const record: ShiftCancellation = {
    id: ids.shiftCancellation(),
    periodId: input.periodId,
    nurseId: input.nurseId,
    shiftTypeId: input.shiftTypeId,
    date: input.date,
    reason,
    cancelledAt: Date.now(),
    enteredBy: input.enteredBy ?? 'manager',
  };
  db.insert(table).values(record).run();
  recordAuditStrict(
    db,
    { entityType: ENTITY, entityId: record.id, action: 'create', actor, after: record, reason },
    { requireReason: true },
  );
  return record;
}

/**
 * Each nurse's cancellations in the year up to `asOf`: how many, and the latest shift date. Only
 * nurses cancelled at least once have an entry; core reads a missing nurse as "never".
 */
export function cancellationHistory(db: DbLike, unitId: Id, asOf: IsoDate): CancellationHistory {
  const since = addDays(asOf, -CANCELLATION_HISTORY_DAYS);
  const rows = db
    .select({ nurseId: table.nurseId, date: table.date })
    .from(table)
    .innerJoin(schedulePeriod, eq(schedulePeriod.id, table.periodId))
    .where(and(eq(schedulePeriod.unitId, unitId), gte(table.date, since)))
    .all();
  const history = new Map<Id, { count: number; lastOn?: IsoDate }>();
  for (const row of rows) {
    const entry = history.get(row.nurseId) ?? { count: 0 };
    entry.count += 1;
    if (entry.lastOn === undefined || compareDates(row.date, entry.lastOn) > 0)
      entry.lastOn = row.date;
    history.set(row.nurseId, entry);
  }
  return history;
}
