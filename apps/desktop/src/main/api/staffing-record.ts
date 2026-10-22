/**
 * The Title 22 staffing record (22 CCR § 70217(c)) for a unit's date range: what was required,
 * what was worked, and the variance, per shift and role. Pure of Electron; the save dialog and
 * the PDF window are in `files.ts`.
 *
 * Only dates a published or archived period covers, and not after today, are recorded: a draft is
 * a proposal and a future date has no actual staffing yet. A shift whose call-off is open or
 * uncovered is left out of "actual" (nobody worked it), as `worked-hours.ts` leaves it out of
 * hours worked; a floated-off row is skipped by `checkStaffing` itself.
 */

import {
  buildStaffingRecord,
  checkStaffing,
  dateInRange,
  datesInRange,
  type Id,
  type IsoDate,
  minDate,
  type Nurse,
  type PaperSize,
  type SchedulePeriod,
  type StaffingRecordDay,
  type StaffingRecordRow,
} from '@shiftnurse/core';
import {
  type DbLike,
  demandInputs,
  demandInputsForDate,
  listAssignmentsForPeriodOnDate,
  listCallOffsForUnit,
  listPeriodsForUnit,
  rosterForPeriod,
} from '@shiftnurse/db';
import { formatInstant } from '../nurse-record-sheet.js';
import { staffingRecordHtml } from '../print-html.js';
import {
  buildStaffingSheet,
  type StaffingRecordSheet,
  staffingRecordCsv,
} from '../staffing-record-sheet.js';
import { unitOrThrow } from './context.js';

/**
 * The published or archived period whose shifts were worked on `date`. Not `periodCoveringDate`:
 * it ranks a draft above an archived period, and a draft laid over an archived one would hide a
 * date that was worked and is on record.
 */
function recordedPeriodOn(periods: readonly SchedulePeriod[], date: IsoDate) {
  const covering = periods.filter(
    (p) => p.status !== 'draft' && dateInRange(date, p.startDate, p.endDate),
  );
  return covering.find((p) => p.status === 'published') ?? covering[0];
}

export function staffingRecordRows(
  db: DbLike,
  unitId: Id,
  start: IsoDate,
  end: IsoDate,
  todayDate: IsoDate,
): StaffingRecordRow[] {
  const last = minDate(end, todayDate);
  if (start > last) return [];
  const notWorked = new Set(
    listCallOffsForUnit(db, unitId, { start, end: last })
      .filter((c) => c.status === 'open' || c.status === 'uncovered')
      .map((c) => c.assignmentId),
  );
  const periods = listPeriodsForUnit(db, unitId);
  const rosters = new Map<Id, Nurse[]>();
  const days: StaffingRecordDay[] = [];
  for (const date of datesInRange(start, last)) {
    const period = recordedPeriodOn(periods, date);
    if (!period) continue;
    let nurses = rosters.get(period.id);
    if (!nurses) {
      nurses = rosterForPeriod(db, period);
      rosters.set(period.id, nurses);
    }
    // The covering period's rules as they stood that day, as Today judges a past date.
    const demand = demandInputsForDate(db, period, date, {
      today: todayDate,
      live: demandInputs(db, unitId, date, date),
    });
    const checks = checkStaffing({
      date,
      shiftTypes: demand.shiftTypes,
      nurses,
      assignments: listAssignmentsForPeriodOnDate(db, period.id, date).filter(
        (a) => !notWorked.has(a.id),
      ),
      demand,
    });
    days.push({ date, shiftTypes: demand.shiftTypes, checks });
  }
  return buildStaffingRecord(days);
}

export interface StaffingRecordDocument {
  sheet: StaffingRecordSheet;
  csv: string;
  html: string;
  /** A file name without its extension: unit, then the dates. */
  baseName: string;
  paper: PaperSize;
}

const slug = (text: string) => text.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '');

export function staffingRecordDocument(
  db: DbLike,
  unitId: Id,
  start: IsoDate,
  end: IsoDate,
  todayDate: IsoDate,
  nowMs: number,
  fallbackPaper: PaperSize = 'letter',
): StaffingRecordDocument {
  const unit = unitOrThrow(db, unitId);
  const rows = staffingRecordRows(db, unitId, start, end, todayDate);
  const sheet = buildStaffingSheet(
    rows,
    unit,
    { start, end: minDate(end, todayDate) },
    formatInstant(nowMs),
  );
  const paper = unit.paperSize ?? fallbackPaper;
  return {
    sheet,
    csv: staffingRecordCsv(sheet),
    html: staffingRecordHtml(sheet, paper),
    baseName: `staffing-record-${slug(unit.name)}-${start}-to-${end}`,
    paper,
  };
}
