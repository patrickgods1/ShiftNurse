/**
 * One nurse's record for a date range, for a grievance or an HR file: every audit entry about
 * them, and every change to their published shifts, oldest first.
 *
 * "About them" is wider than the nurse's own row. Most of what a manager does to a nurse is
 * recorded against something else — a shift, a leave request, a bid, a cancellation, a call-off,
 * an exchange — whose snapshot carries the nurse's id under a key. The audit table has no nurse
 * column, so the match is on the snapshot text: SQLite's `instr` over the JSON for the exact
 * `"nurseId":"<id>"` pair (JSON.stringify writes no spaces, and `instr`, unlike LIKE, has no
 * wildcards for an id to trip over). That is a scan of the rows in the date window, which the
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

import {
  compareDates,
  dayNumber,
  type Id,
  type IsoDate,
  MS_PER_DAY,
  type Nurse,
  today,
} from '@shiftnurse/core';
import { and, asc, eq, gte, lt, notInArray, or, sql } from 'drizzle-orm';
import type { DbLike } from '../client.js';
import { toNurse } from '../mappers.js';
import { auditLog, nurse as nurseTable, scheduleChange, schedulePeriod } from '../schema.js';

/**
 * Entities whose entries never leave the app in a record: who is kept apart and why is an HR
 * matter, and an FMLA certification concerns a medical condition. A record travels to unions and
 * grievance panels, so neither belongs in it; leave taken under FMLA still appears as leave.
 */
export const RECORD_EXCLUDED_ENTITIES = ['incompatibility_group', 'fmla_certification'] as const;

/** Snapshot keys that name a nurse as a party to the entry. */
const NURSE_KEYS = ['nurseId', 'requestingNurseId', 'counterpartyNurseId'] as const;

const PAD_MS = 36 * 3_600_000;

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
  const from = dayNumber(start) * MS_PER_DAY - PAD_MS;
  const to = (dayNumber(end) + 1) * MS_PER_DAY + PAD_MS;
  const inRange = (at: number) => {
    const day = today(new Date(at));
    return compareDates(day, start) >= 0 && compareDates(day, end) <= 0;
  };

  const about = or(
    and(eq(auditLog.entityType, 'nurse'), eq(auditLog.entityId, nurseId)),
    ...NURSE_KEYS.flatMap((key) => {
      const pair = `"${key}":${JSON.stringify(nurseId)}`;
      return [
        sql`instr(${auditLog.before}, ${pair}) > 0`,
        sql`instr(${auditLog.after}, ${pair}) > 0`,
      ];
    }),
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
