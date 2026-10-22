/**
 * Comp-time elections: the dates over which a nurse has agreed, in advance, to take comp time
 * instead of overtime pay on a unit.
 *
 * 29 U.S.C. § 207(o) (and 38 U.S.C. § 7453(e)(3) for the VA) allow comp time only by an agreement
 * made before the work, so a credit is banked only for overtime dated inside an election. Two
 * elections that overlap would make "which one covers this shift" a matter of opinion, and one
 * that ends before it starts covers nothing while looking like cover; both are refused here, in
 * words the manager can act on. Each write carries the nurse in its audit snapshot so the entry
 * reaches her record.
 *
 * Credits are the other half: the comp hours banked from one finished published period. They are
 * final (append-only by trigger), so a period is banked once, whole, and a second run is refused
 * rather than topping up — a wrong figure is corrected by entering payroll's comp balance.
 */

import type { CompTimeElection, Id, IsoDate } from '@shiftnurse/core';
import { compareDates, describeDate, maxDate, today } from '@shiftnurse/core';
import { and, asc, eq, ne, type SQL } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike, ShiftNurseTx } from '../client.js';
import { ids } from '../ids.js';
import { compTimeCredit, nurse, schedulePeriod, compTimeElection as table } from '../schema.js';
import { requireWorksOnUnit } from './nurse-units.js';
import { type PatchKeys, patchOf } from './patch.js';

const ENTITY = 'comp_time_election';

export type CompTimeElectionInput = Omit<CompTimeElection, 'id' | 'enteredBy'> & {
  enteredBy?: CompTimeElection['enteredBy'];
};

/** Nurse and unit never change: to move an election, delete it and record another. */
export interface CompTimeElectionPatch {
  startsOn?: IsoDate;
  /** `null` makes the election open-ended; an omitted key is left alone. */
  endsOn?: IsoDate | null;
  /** `null` clears the note; an omitted key is left alone. */
  note?: string | null;
}

const KEYS: PatchKeys<CompTimeElectionPatch> = { startsOn: true, endsOn: true, note: true };

function toElection(r: typeof table.$inferSelect): CompTimeElection {
  return {
    id: r.id,
    unitId: r.unitId,
    nurseId: r.nurseId,
    startsOn: r.startsOn,
    ...(r.endsOn ? { endsOn: r.endsOn } : {}),
    ...(r.note ? { note: r.note } : {}),
    enteredBy: r.enteredBy === 'nurse' ? 'nurse' : 'manager',
  };
}

export function listCompTimeElectionsForNurse(db: DbLike, nurseId: Id): CompTimeElection[] {
  return db
    .select()
    .from(table)
    .where(eq(table.nurseId, nurseId))
    .orderBy(asc(table.startsOn), asc(table.id))
    .all()
    .map(toElection);
}

export function listCompTimeElectionsForUnit(db: DbLike, unitId: Id): CompTimeElection[] {
  return db
    .select()
    .from(table)
    .where(eq(table.unitId, unitId))
    .orderBy(asc(table.startsOn), asc(table.nurseId), asc(table.id))
    .all()
    .map(toElection);
}

export function getCompTimeElection(db: DbLike, id: Id): CompTimeElection | undefined {
  const row = db.select().from(table).where(eq(table.id, id)).get();
  return row ? toElection(row) : undefined;
}

/** Inclusive on both ends; an absent end runs on for ever. */
function overlapStart(a: CompTimeElection, b: CompTimeElection): IsoDate | undefined {
  const aStartsBeforeBEnds = b.endsOn === undefined || compareDates(a.startsOn, b.endsOn) <= 0;
  const bStartsBeforeAEnds = a.endsOn === undefined || compareDates(b.startsOn, a.endsOn) <= 0;
  return aStartsBeforeBEnds && bStartsBeforeAEnds ? maxDate(a.startsOn, b.startsOn) : undefined;
}

function validate(db: DbLike, e: CompTimeElection): void {
  if (e.endsOn !== undefined && compareDates(e.endsOn, e.startsOn) < 0) {
    throw new Error('The comp-time election ends before it starts.');
  }
  const others = db
    .select()
    .from(table)
    .where(and(eq(table.nurseId, e.nurseId), eq(table.unitId, e.unitId), ne(table.id, e.id)))
    .all()
    .map(toElection);
  for (const other of others) {
    const day = overlapStart(e, other);
    if (day === undefined) continue;
    const who = db.select().from(nurse).where(eq(nurse.id, e.nurseId)).get();
    const name = who ? `${who.firstName} ${who.lastName}` : 'This nurse';
    throw new Error(`${name} already has a comp-time election covering ${describeDate(day)}.`);
  }
}

export function createCompTimeElection(
  db: DbLike,
  input: CompTimeElectionInput,
  actor: string,
): CompTimeElection {
  const note = input.note?.trim();
  const election: CompTimeElection = {
    id: ids.compTimeElection(),
    unitId: input.unitId,
    nurseId: input.nurseId,
    startsOn: input.startsOn,
    ...(input.endsOn ? { endsOn: input.endsOn } : {}),
    ...(note ? { note } : {}),
    enteredBy: input.enteredBy ?? 'manager',
  };
  requireWorksOnUnit(db, election.nurseId, election.unitId, {
    start: election.startsOn,
    end: election.startsOn,
  });
  validate(db, election);
  db.insert(table)
    .values({
      ...election,
      endsOn: election.endsOn ?? null,
      note: election.note ?? null,
      createdAt: Date.now(),
    })
    .run();
  recordAudit(db, {
    entityType: ENTITY,
    entityId: election.id,
    action: 'create',
    actor,
    after: election,
  });
  return election;
}

export function updateCompTimeElection(
  db: DbLike,
  id: Id,
  patch: CompTimeElectionPatch,
  actor: string,
): CompTimeElection {
  const before = getCompTimeElection(db, id);
  if (!before) throw new Error(`Comp-time election ${id} not found`);
  const changes = patchOf(patch, KEYS, 'comp-time election');
  const after: CompTimeElection = { ...before };
  if (changes.startsOn !== undefined) after.startsOn = changes.startsOn;
  if (changes.endsOn !== undefined) {
    if (changes.endsOn === null) delete after.endsOn;
    else after.endsOn = changes.endsOn;
  }
  if (changes.note !== undefined) {
    const note = changes.note?.trim();
    if (note) after.note = note;
    else delete after.note;
  }
  if (after.startsOn !== before.startsOn) {
    requireWorksOnUnit(db, after.nurseId, after.unitId, {
      start: after.startsOn,
      end: after.startsOn,
    });
  }
  validate(db, after);
  db.update(table)
    .set({
      startsOn: after.startsOn,
      endsOn: after.endsOn ?? null,
      note: after.note ?? null,
    })
    .where(eq(table.id, id))
    .run();
  recordAudit(db, {
    entityType: ENTITY,
    entityId: id,
    action: 'update',
    actor,
    before,
    after,
  });
  return after;
}

export function deleteCompTimeElection(db: DbLike, id: Id, actor: string): void {
  const before = getCompTimeElection(db, id);
  if (!before) throw new Error(`Comp-time election ${id} not found`);
  db.delete(table).where(eq(table.id, id)).run();
  recordAudit(db, {
    entityType: ENTITY,
    entityId: id,
    action: 'delete',
    actor,
    before,
  });
}

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

const CREDIT_ENTITY = 'comp_time_credit';

/** Comp hours banked for one nurse from one period, with the period's last day. */
export interface CompTimeCreditRecord {
  id: Id;
  nurseId: Id;
  periodId: Id;
  /** The period's last day: a credit is earned then, so it counts toward a balance from the next. */
  periodEndDate: IsoDate;
  overtimeHours: number;
  creditedHours: number;
  /** Overtime past the cap, still paid in cash. */
  paidOvertimeHours: number;
  createdAt: number;
}

export interface CompTimeCreditInput {
  nurseId: Id;
  overtimeHours: number;
  creditedHours: number;
  paidOvertimeHours: number;
}

function creditsWhere(db: DbLike, where: SQL): CompTimeCreditRecord[] {
  return db
    .select({
      id: compTimeCredit.id,
      nurseId: compTimeCredit.nurseId,
      periodId: compTimeCredit.periodId,
      periodEndDate: schedulePeriod.endDate,
      overtimeHours: compTimeCredit.overtimeHours,
      creditedHours: compTimeCredit.creditedHours,
      paidOvertimeHours: compTimeCredit.paidOvertimeHours,
      createdAt: compTimeCredit.createdAt,
    })
    .from(compTimeCredit)
    .innerJoin(schedulePeriod, eq(schedulePeriod.id, compTimeCredit.periodId))
    .where(where)
    .orderBy(asc(schedulePeriod.endDate), asc(compTimeCredit.nurseId), asc(compTimeCredit.id))
    .all()
    .map((r) => ({ ...r, periodEndDate: r.periodEndDate as IsoDate }));
}

export function listCompTimeCreditsForPeriod(db: DbLike, periodId: Id): CompTimeCreditRecord[] {
  return creditsWhere(db, eq(compTimeCredit.periodId, periodId));
}

export function listCompTimeCreditsForNurse(db: DbLike, nurseId: Id): CompTimeCreditRecord[] {
  return creditsWhere(db, eq(compTimeCredit.nurseId, nurseId));
}

/**
 * Banks a period's comp time: every nurse's credit and its audit row, or nothing. Takes
 * `ShiftNurseTx` because half a period banked could not be finished — the refusal below would
 * stop the rest — and could not be undone, since credits are append-only.
 */
export function recordCompTimeCredits(
  tx: ShiftNurseTx,
  periodId: Id,
  rows: readonly CompTimeCreditInput[],
  actor: string,
): CompTimeCreditRecord[] {
  const period = tx.select().from(schedulePeriod).where(eq(schedulePeriod.id, periodId)).get();
  if (!period) throw new Error('That schedule period no longer exists. Reload the page.');
  const earlier = tx
    .select({ createdAt: compTimeCredit.createdAt })
    .from(compTimeCredit)
    .where(eq(compTimeCredit.periodId, periodId))
    .get();
  if (earlier) {
    // The day it was banked is an event's local date, read from its instant.
    const on = describeDate(today(new Date(earlier.createdAt)), { year: true });
    throw new Error(`Comp time for this period was already banked on ${on}.`);
  }
  const createdAt = Date.now();
  return rows.map((row) => {
    const record: CompTimeCreditRecord = {
      id: ids.compTimeCredit(),
      nurseId: row.nurseId,
      periodId,
      periodEndDate: period.endDate as IsoDate,
      overtimeHours: row.overtimeHours,
      creditedHours: row.creditedHours,
      paidOvertimeHours: row.paidOvertimeHours,
      createdAt,
    };
    tx.insert(compTimeCredit)
      .values({
        id: record.id,
        nurseId: record.nurseId,
        periodId,
        overtimeHours: record.overtimeHours,
        creditedHours: record.creditedHours,
        paidOvertimeHours: record.paidOvertimeHours,
        createdAt,
      })
      .run();
    recordAudit(tx, {
      entityType: CREDIT_ENTITY,
      entityId: record.id,
      action: 'create',
      actor,
      after: record,
    });
    return record;
  });
}
