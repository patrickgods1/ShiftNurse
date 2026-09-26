/**
 * The fairness ledger: one row of burden counters per nurse per period, written at publish and
 * by the historical import, read back as the history fairness scoring balances against.
 */

import type { FairnessLedgerEntry, Id, IsoDate } from '@shiftnurse/core';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike, ShiftNurseTx } from '../client.js';
import { ids } from '../ids.js';
import { toFairnessLedgerEntry } from '../mappers.js';
import { fairnessLedger, nurse } from '../schema.js';
import { insertRows } from './bulk.js';

// ---------------------------------------------------------------------------
// Fairness ledger
// ---------------------------------------------------------------------------

export function getFairnessLedgerEntry(
  db: DbLike,
  nurseId: Id,
  periodId: Id,
): FairnessLedgerEntry | undefined {
  const row = db
    .select()
    .from(fairnessLedger)
    .where(and(eq(fairnessLedger.nurseId, nurseId), eq(fairnessLedger.periodId, periodId)))
    .get();
  return row ? toFairnessLedgerEntry(row) : undefined;
}

/** A ledger row's counters, with every omitted counter as 0 — the one place those defaults live. */
function ledgerValues(input: UpsertFairnessLedgerInput) {
  return {
    periodStart: input.periodStart,
    nightShifts: input.nightShifts ?? 0,
    weekendsWorked: input.weekendsWorked ?? 0,
    holidaysWorked: input.holidaysWorked ?? 0,
    onCallShifts: input.onCallShifts ?? 0,
    undesirableShifts: input.undesirableShifts ?? 0,
    requestsApproved: input.requestsApproved ?? 0,
    requestsDenied: input.requestsDenied ?? 0,
    callOutsCovered: input.callOutsCovered ?? 0,
    totalHours: input.totalHours ?? 0,
    overtimeHours: input.overtimeHours ?? 0,
    preferenceHitRate: input.preferenceHitRate ?? 0,
  };
}

function ledgerRow(input: UpsertFairnessLedgerInput) {
  return {
    id: ids.fairness(),
    nurseId: input.nurseId,
    periodId: input.periodId,
    ...ledgerValues(input),
  };
}

/**
 * A rolling window of ledger entries for every nurse in a unit, ordered by period start.
 * Fairness scoring reads this to compare a nurse's recent burden against the team's.
 *
 * Scoped through `nurse`, same reasoning as `timeoff.ts` and `lastCalledAt`: the ledger
 * itself has no unit column.
 */
export function ledgerSince(db: DbLike, unitId: Id, sinceDate: IsoDate): FairnessLedgerEntry[] {
  const rows = db
    .select({ ledger: fairnessLedger })
    .from(fairnessLedger)
    .innerJoin(nurse, eq(fairnessLedger.nurseId, nurse.id))
    .where(and(eq(nurse.unitId, unitId), gte(fairnessLedger.periodStart, sinceDate)))
    .orderBy(fairnessLedger.periodStart)
    .all();
  return rows.map((r) => toFairnessLedgerEntry(r.ledger));
}

export interface UpsertFairnessLedgerInput {
  nurseId: Id;
  periodId: Id;
  periodStart: IsoDate;
  nightShifts?: number;
  weekendsWorked?: number;
  holidaysWorked?: number;
  onCallShifts?: number;
  undesirableShifts?: number;
  requestsApproved?: number;
  requestsDenied?: number;
  callOutsCovered?: number;
  totalHours?: number;
  overtimeHours?: number;
  preferenceHitRate?: number;
}

export function upsertFairnessLedgerEntry(
  db: DbLike,
  input: UpsertFairnessLedgerInput,
  actor: string,
): FairnessLedgerEntry {
  const existing = db
    .select()
    .from(fairnessLedger)
    .where(
      and(eq(fairnessLedger.nurseId, input.nurseId), eq(fairnessLedger.periodId, input.periodId)),
    )
    .get();

  const values = ledgerValues(input);

  if (existing) {
    const before = toFairnessLedgerEntry(existing);
    db.update(fairnessLedger).set(values).where(eq(fairnessLedger.id, existing.id)).run();
    const after: FairnessLedgerEntry = { ...before, ...values };
    recordAudit(db, {
      entityType: 'fairness_ledger',
      entityId: existing.id,
      action: 'update',
      actor,
      before,
      after,
    });
    return after;
  }

  const id = ids.fairness();
  const row = { id, nurseId: input.nurseId, periodId: input.periodId, ...values };
  db.insert(fairnessLedger).values(row).run();
  const created = toFairnessLedgerEntry(row);
  recordAudit(db, {
    entityType: 'fairness_ledger',
    entityId: id,
    action: 'create',
    actor,
    after: created,
  });
  return created;
}

/**
 * Bulk-insert historical ledger entries, e.g. when onboarding a unit mid-year from a paper
 * or spreadsheet system. One `'import'` audit entry covers the whole batch — recording each
 * row individually would bury the one fact that matters ("we imported N periods of history
 * on this date") under N indistinguishable `'create'` entries.
 */
export function importFairnessLedgerEntries(
  db: DbLike,
  entries: readonly UpsertFairnessLedgerInput[],
  actor: string,
): FairnessLedgerEntry[] {
  const rows = entries.map((input) => ledgerRow(input));
  insertRows(db, fairnessLedger, rows);
  const created = rows.map(toFairnessLedgerEntry);
  recordAudit(db, {
    entityType: 'fairness_ledger',
    entityId: 'batch' as Id,
    action: 'import',
    actor,
    after: { count: created.length },
  });
  return created;
}

/**
 * Period ids (with their start dates) already in the ledger for this unit's nurses.
 *
 * The historical-import screen needs this to warn a manager before they re-import a file that
 * would replace periods already on record, rather than let `importHistoricalLedger` silently
 * do the replacing.
 */
export function ledgerPeriodsForUnit(
  db: DbLike,
  unitId: Id,
): { periodId: Id; periodStart: IsoDate }[] {
  return db
    .selectDistinct({
      periodId: fairnessLedger.periodId,
      periodStart: fairnessLedger.periodStart,
    })
    .from(fairnessLedger)
    .innerJoin(nurse, eq(fairnessLedger.nurseId, nurse.id))
    .where(eq(nurse.unitId, unitId))
    .orderBy(fairnessLedger.periodStart)
    .all()
    .map((r) => ({ periodId: r.periodId, periodStart: r.periodStart as IsoDate }));
}

export interface LedgerImportResult {
  written: number;
  replaced: number;
}

/**
 * Import a historical schedule's derived ledger rows, replacing rather than upserting.
 *
 * `importFairnessLedgerEntries` (above) inserts blindly and exists for a one-time initial
 * seed. A CSV import is different: the manager may re-run it after fixing a typo in the
 * spreadsheet, and re-running it must not pile up duplicate rows behind the
 * `(nurseId, periodId)` unique index, nor leave some nurses on the old numbers and others on
 * the new ones for what is supposed to be a single period's history. So every period id
 * present in `entries` is cleared for this unit first — and only for this unit, so importing
 * one unit's history can never erase another's — and the new rows are inserted in its place,
 * all inside the caller's transaction (partial replacement is worse than none).
 *
 * Throws before making any change if an entry names a nurse who isn't on this unit: a ledger
 * row for the wrong unit is a data-integrity bug, not a case to paper over.
 */
export function importHistoricalLedger(
  // A transaction, not any handle: these writes are only correct all-or-nothing.
  db: ShiftNurseTx,
  unitId: Id,
  entries: readonly UpsertFairnessLedgerInput[],
  actor: string,
): LedgerImportResult {
  const unitNurseIds = new Set(
    db
      .select({ id: nurse.id })
      .from(nurse)
      .where(eq(nurse.unitId, unitId))
      .all()
      .map((r) => r.id),
  );
  for (const entry of entries) {
    if (!unitNurseIds.has(entry.nurseId)) {
      throw new Error(
        `Cannot import a fairness ledger entry for nurse ${entry.nurseId}: not a nurse on unit ${unitId}.`,
      );
    }
  }

  const periodIds = [...new Set(entries.map((e) => e.periodId))];
  const nurseIdList = [...unitNurseIds];
  let replaced = 0;
  for (const periodId of periodIds) {
    const existing = db
      .select({ id: fairnessLedger.id })
      .from(fairnessLedger)
      .where(
        and(eq(fairnessLedger.periodId, periodId), inArray(fairnessLedger.nurseId, nurseIdList)),
      )
      .all();
    if (existing.length > 0) {
      db.delete(fairnessLedger)
        .where(
          inArray(
            fairnessLedger.id,
            existing.map((r) => r.id),
          ),
        )
        .run();
      replaced += existing.length;
    }
  }

  insertRows(
    db,
    fairnessLedger,
    entries.map((input) => ledgerRow(input)),
  );
  const written = entries.length;

  recordAudit(db, {
    entityType: 'fairness_ledger',
    entityId: 'batch' as Id,
    action: 'import',
    actor,
    before: { replaced, periodIds },
    after: { written, periodIds },
  });

  return { written, replaced };
}
