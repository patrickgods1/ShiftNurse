/**
 * One nurse's record for a date range, for a grievance or an HR file: every audit entry about
 * them, and every change to their published shifts, oldest first.
 *
 * "About them" is wider than the nurse's own row. Most of what a manager does to a nurse is
 * recorded against something else — a shift, a leave request, a bid, a cancellation, a call-off,
 * an exchange — whose snapshot carries the nurse's id under a key. The audit table has no nurse
 * column, so the match is on the snapshot text: SQLite's `instr` over the JSON for the exact
 * `"nurseId":"<id>"` pair (JSON.stringify writes no spaces, and `instr`, unlike LIKE, has no
 * wildcards for an id to trip over). The keys are `RECORD_NURSE_KEYS` (a shift's nurse, both
 * parties to an exchange, the orientee and the preceptor) and, for entries about several nurses
 * at once, a top-level `nurseIds` array matched element by element. `heldBy` (a bid denial's
 * "who holds those places") is deliberately not a key: that entry is about the denied nurse, not
 * about the colleagues who were awarded. That is a scan of the rows in the date window, which the
 * `audit_at_idx` index bounds; a per-nurse index would need a column on every audit write.
 *
 * What it leaves out, on purpose: the incompatibility group's entries. Their reason is HR
 * sensitive and must never reach output that can be grieved, and they would not name a nurse by
 * `nurseId` anyway; the filter is by entity type so no later key can leak one. Only the fields a
 * reader needs go out (when, what, who, why), never the before/after snapshots, which hold
 * contact details and leave notes.
 *
 * The range is calendar days as the manager reads them, and an entry's time is a real instant,
 * so an entry belongs to the day it fell on *locally* — core's `today(date)`, the same
 * conversion the daily backup uses. The query pads the window by a day and a half either side
 * (every timezone) and the day test settles the edges.
 */

import { compareDates, type Id, type IsoDate, type Nurse } from '@shiftnurse/core';
import { and, asc, eq, gte, lt, notInArray, or, sql } from 'drizzle-orm';
import type { DbLike } from '../client.js';
import { instantWindow, onLocalDays } from '../local-days.js';
import { toNurse } from '../mappers.js';
import { auditLog, nurse as nurseTable, scheduleChange, schedulePeriod } from '../schema.js';

/**
 * Entities whose entries never leave the app in a record: who is kept apart and why is an HR
 * matter, an FMLA certification concerns a medical condition, and an accommodation's reason names
 * a disability, a pregnancy or a faith. A record travels to unions and grievance panels, so none
 * belongs in it; leave taken under FMLA still appears as leave.
 * The export dialog (`pages/roster/nurse-record.tsx`) names these three; change both together.
 */
export const RECORD_EXCLUDED_ENTITIES = [
  'incompatibility_group',
  'fmla_certification',
  'availability_block',
] as const;

/** Snapshot keys that name a nurse as a party to the entry. */
export const RECORD_NURSE_KEYS = [
  'nurseId',
  'requestingNurseId',
  'counterpartyNurseId',
  'orienteeId',
  'preceptorId',
] as const;

/** Top-level snapshot arrays of nurse ids, such as the nurses recorded as working a holiday. */
export const RECORD_NURSE_ARRAY_KEYS = ['nurseIds'] as const;

export interface RecordAuditEntry {
  id: Id;
  /** Epoch millis: a real instant. */
  at: number;
  entityType: string;
  entityId: Id;
  action: string;
  actor: string;
  reason?: string;
  /** The date or span the entry concerns, when its snapshot has one ("2026-10-06", "a to b"). */
  concerns?: string;
}

export interface RecordScheduleChange {
  id: Id;
  at: number;
  periodId: Id;
  periodName: string;
  kind: string;
  source: string;
  /** The shift's date. */
  date: IsoDate;
  shiftTypeId: Id;
  actor: string;
  reason: string;
}

export interface NurseRecord {
  nurse: Nurse;
  start: IsoDate;
  end: IsoDate;
  audit: RecordAuditEntry[];
  scheduleChanges: RecordScheduleChange[];
}

function concernsOf(snapshot: unknown): string | undefined {
  if (typeof snapshot !== 'object' || snapshot === null) return undefined;
  const s = snapshot as Record<string, unknown>;
  if (typeof s.date === 'string') return s.date;
  if (typeof s.startsOn === 'string') {
    return typeof s.endsOn === 'string' && s.endsOn !== s.startsOn
      ? `${s.startsOn} to ${s.endsOn}`
      : s.startsOn;
  }
  if (typeof s.startDate === 'string') {
    return typeof s.endDate === 'string' && s.endDate !== s.startDate
      ? `${s.startDate} to ${s.endDate}`
      : s.startDate;
  }
  return undefined;
}

export function nurseRecord(db: DbLike, nurseId: Id, start: IsoDate, end: IsoDate): NurseRecord {
  const row = db.select().from(nurseTable).where(eq(nurseTable.id, nurseId)).get();
  if (!row) throw new Error('That nurse is not on the roster');
  if (compareDates(end, start) < 0) throw new Error('The record ends before it starts');
  const window = instantWindow(start, end);
  const from = window.from;
  const to = window.to!; // `end` is given, so the window is closed
  const inRange = (at: number) => onLocalDays(at, start, end);

  const about = or(
    and(eq(auditLog.entityType, 'nurse'), eq(auditLog.entityId, nurseId)),
    ...RECORD_NURSE_KEYS.flatMap((key) => {
      const pair = `"${key}":${JSON.stringify(nurseId)}`;
      return [
        sql`instr(${auditLog.before}, ${pair}) > 0`,
        sql`instr(${auditLog.after}, ${pair}) > 0`,
      ];
    }),
    // An exact element match: `instr` on a bare id would also hit it under unrelated keys.
    ...RECORD_NURSE_ARRAY_KEYS.flatMap((key) =>
      [auditLog.before, auditLog.after].map(
        (column) =>
          sql`(json_valid(${column}) and exists (select 1 from json_each(${column}, ${`$.${key}`}) where value = ${nurseId}))`,
      ),
    ),
  );
  const audit = db
    .select()
    .from(auditLog)
    .where(
      and(
        gte(auditLog.at, from),
        lt(auditLog.at, to),
        notInArray(auditLog.entityType, [...RECORD_EXCLUDED_ENTITIES]),
        about,
      ),
    )
    .orderBy(asc(auditLog.at), sql`${auditLog}.rowid`)
    .all()
    .filter((r) => inRange(r.at))
    .map((r): RecordAuditEntry => {
      const concerns = concernsOf(r.after) ?? concernsOf(r.before);
      return {
        id: r.id,
        at: r.at,
        entityType: r.entityType,
        entityId: r.entityId,
        action: r.action,
        actor: r.actor,
        ...(r.reason ? { reason: r.reason } : {}),
        ...(concerns ? { concerns } : {}),
      };
    });

  const scheduleChanges = db
    .select({ change: scheduleChange, periodName: schedulePeriod.name })
    .from(scheduleChange)
    .innerJoin(schedulePeriod, eq(schedulePeriod.id, scheduleChange.periodId))
    .where(
      and(
        eq(scheduleChange.nurseId, nurseId),
        gte(scheduleChange.at, from),
        lt(scheduleChange.at, to),
      ),
    )
    .orderBy(asc(scheduleChange.at), sql`${scheduleChange}.rowid`)
    .all()
    .filter((r) => inRange(r.change.at))
    .map(
      (r): RecordScheduleChange => ({
        id: r.change.id,
        at: r.change.at,
        periodId: r.change.periodId,
        periodName: r.periodName,
        kind: r.change.kind,
        source: r.change.source,
        date: r.change.date as IsoDate,
        shiftTypeId: r.change.shiftTypeId,
        actor: r.change.actor,
        reason: r.change.reason,
      }),
    );

  return { nurse: toNurse(row), start, end, audit, scheduleChanges };
}
