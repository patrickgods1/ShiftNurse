/**
 * A nurse's record as a sheet of plain strings, and its CSV.
 *
 * The record (`nurseRecord` in the db package) is rows; what goes on paper is words: entity types
 * as a manager says them, instants in one unambiguous format, shift types by abbreviation. Doing
 * that once here means the CSV and the PDF cannot disagree about what a row says, and neither
 * needs Electron, so the whole file is testable under plain Node.
 *
 * Times are written as UTC instants ("2026-10-06 19:42 UTC"): this file may be handed to a union
 * representative in another timezone, and "when" is the first thing a grievance turns on.
 */

import { type IsoDate, type ShiftType, serializeCsv, type Unit } from '@shiftnurse/core';
import type { NurseRecord } from '@shiftnurse/db';

/** Said in the footer of every record, whether or not the nurse is in any such group. */
export const KEPT_APART_NOTE =
  'Entries about kept-apart (incompatible staff) groups, FMLA medical certifications and recorded accommodations, and the reasons for them, are never included in this record.';

export interface RecordSheet {
  nurseName: string;
  employeeId: string;
  unitName: string;
  start: IsoDate;
  end: IsoDate;
  generatedOn: IsoDate;
  audit: {
    time: string;
    what: string;
    action: string;
    actor: string;
    concerns: string;
    reason: string;
  }[];
  changes: {
    time: string;
    kind: string;
    shift: string;
    period: string;
    source: string;
    actor: string;
    reason: string;
  }[];
}

const ENTITY_WORDS: Record<string, string> = {
  assignment: 'Shift',
  time_off_request: 'Time-off request',
  shift_swap: 'Shift exchange',
  call_off: 'Call-off',
  call_attempt: 'Call-off call',
  shift_cancellation: 'Low-census cancellation',
  leave_bid: 'Leave bid',
  leave_balance: 'Leave balance',
  fmla_certification: 'FMLA certification',
  nurse: 'Nurse record',
  nurse_credential: 'Credential',
  nurse_unit: 'Float assignment',
  preceptorship: 'Orientation',
  overtime_volunteer: 'Overtime offer',
  day_of_pay_event: 'Day-of pay event',
  schedule_change: 'Change to a published shift',
};

function entityWords(type: string): string {
  const known = ENTITY_WORDS[type];
  if (known) return known;
  const spaced = type.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function formatInstant(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function buildRecordSheet(
  record: NurseRecord,
  unit: Pick<Unit, 'name'>,
  shiftTypes: readonly Pick<ShiftType, 'id' | 'abbreviation'>[],
  generatedOn: IsoDate,
): RecordSheet {
  const abbreviation = new Map(shiftTypes.map((t) => [t.id, t.abbreviation]));
  return {
    nurseName: `${record.nurse.firstName} ${record.nurse.lastName}`,
    employeeId: record.nurse.employeeId,
    unitName: unit.name,
    start: record.start,
    end: record.end,
    generatedOn,
    audit: record.audit.map((r) => ({
      time: formatInstant(r.at),
      what: entityWords(r.entityType),
      action: r.action,
      actor: r.actor,
      concerns: r.concerns ?? '',
      reason: r.reason ?? '',
    })),
    changes: record.scheduleChanges.map((c) => ({
      time: formatInstant(c.at),
      kind: c.kind,
      shift: `${c.date} ${abbreviation.get(c.shiftTypeId) ?? c.shiftTypeId}`,
      period: c.periodName,
      source: c.source,
      actor: c.actor,
      reason: c.reason,
    })),
  };
}

const COLUMNS = [
  'nurse',
  'employee_id',
  'section',
  'time',
  'what',
  'action',
  'actor',
  'concerns',
  'reason',
];

/** One table, entries then published-shift changes, each oldest first; a last row carries the note. */
export function recordCsv(sheet: RecordSheet): string {
  const who = [sheet.nurseName, sheet.employeeId];
  return serializeCsv([
    COLUMNS,
    ...sheet.audit.map((r) => [
      ...who,
      'audit entry',
      r.time,
      r.what,
      r.action,
      r.actor,
      r.concerns,
      r.reason,
    ]),
    ...sheet.changes.map((c) => [
      ...who,
      'published schedule change',
      c.time,
      `Shift ${c.shift} (${c.period})`,
      c.kind,
      c.actor,
      c.shift.split(' ')[0] ?? '',
      c.reason,
    ]),
    [...who, 'note', '', '', '', '', '', KEPT_APART_NOTE],
  ]);
}
