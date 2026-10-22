/**
 * The Title 22 staffing record as a sheet of plain strings, and its CSV.
 *
 * Same split as `nurse-record-sheet.ts`: the rows come from core's `buildStaffingRecord`, and what
 * goes on paper is words, written once here so the CSV and the PDF cannot disagree. It names the
 * regulation and the export time because the file is evidence — an inspector asks when it was
 * produced and what it claims to cover.
 */

import {
  type IsoDate,
  type StaffingRecordRole,
  type StaffingRecordRow,
  serializeCsv,
  type Unit,
} from '@shiftnurse/core';

export const STAFFING_RECORD_CITATION = '22 CCR § 70217(c)';

export interface StaffingRecordSheet {
  unitName: string;
  start: IsoDate;
  /** The last date the record covers: the requested end, or today when that is later. */
  end: IsoDate;
  /** "2026-10-22 14:05 UTC", the instant the file was made. */
  generatedAt: string;
  rows: {
    date: string;
    shift: string;
    role: string;
    census: string;
    basis: string;
    required: string;
    actual: string;
    variance: string;
  }[];
}

const ROLE_WORDS: Record<StaffingRecordRole, string> = {
  RN: 'RN',
  LPN: 'LPN',
  CNA: 'CNA',
  licensed: 'Licensed pool',
};

export const STAFFING_RECORD_COLUMNS = [
  'Date',
  'Shift',
  'Role',
  'Census',
  'Basis',
  'Required',
  'Actual',
  'Variance',
];

export function buildStaffingSheet(
  rows: readonly StaffingRecordRow[],
  unit: Pick<Unit, 'name'>,
  range: { start: IsoDate; end: IsoDate },
  generatedAt: string,
): StaffingRecordSheet {
  return {
    unitName: unit.name,
    start: range.start,
    end: range.end,
    generatedAt,
    rows: rows.map((r) => ({
      date: r.date,
      shift: r.shiftTypeName,
      role: ROLE_WORDS[r.role],
      // A floor-only day has no census behind it; say so rather than print a 0.
      census: r.basis === 'floor' ? '' : String(r.census),
      basis: r.basis,
      required: String(r.required),
      actual: String(r.actual),
      variance: String(r.variance),
    })),
  };
}

/** The header lines, a blank row, then one table: a spreadsheet shows the facts above the grid. */
export function staffingRecordCsv(sheet: StaffingRecordSheet): string {
  return serializeCsv([
    [`Staffing record (${STAFFING_RECORD_CITATION}): ${sheet.unitName}`],
    [`${sheet.start} to ${sheet.end}`],
    [`Exported ${sheet.generatedAt}`],
    [],
    STAFFING_RECORD_COLUMNS,
    ...sheet.rows.map((r) => [
      r.date,
      r.shift,
      r.role,
      r.census,
      r.basis,
      r.required,
      r.actual,
      r.variance,
    ]),
  ]);
}
