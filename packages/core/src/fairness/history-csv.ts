/**
 * Historical schedule import — turns a spreadsheet of past shifts into ledger-ready rows.
 *
 * ## Why this module exists
 *
 * A unit onboarding mid-year has months of schedules sitting in a spreadsheet, not in
 * ShiftNurse. Without a way to bring that history in, fairness scoring starts from a blank
 * slate and the very first generated schedule hands every holiday and night run to whoever
 * happens to sort first alphabetically — the opposite of what fairness scoring exists to
 * prevent. Parsing the sheet into {@link HistoricalShiftRow}s, and bucketing those into the
 * unit's own pay periods, is what lets the ledger importer (`packages/db`) seed real burden
 * history on day one.
 *
 * Reuses `parseCsv`/`serializeCsv` from `roster/csv.ts` — the one CSV parser in this repo —
 * and `payPeriodIndex`/`payPeriodWindow` from `rules/hours-rules.ts` so imported history lands
 * in exactly the periods the rest of the app already reasons about, rather than a second,
 * subtly different notion of "pay period".
 */

import type { Nurse, ShiftType, Unit } from '../domain/entities.js';
import { compareDates, type IsoDate, isIsoDate } from '../domain/time.js';
import { parseCsv, serializeCsv } from '../roster/csv.js';
import { payPeriodIndex, payPeriodWindow } from '../rules/hours-rules.js';
import type { HistoricalCsvError, HistoricalPeriod, HistoricalShiftRow } from './types.js';

export const HISTORY_COLUMNS = ['employee_id', 'date', 'shift'] as const;

type HistoryColumn = (typeof HISTORY_COLUMNS)[number];

export interface ParseHistoryOptions {
  /** Matched against `employeeId`, active or not — a nurse who has since left still worked
   * the history being imported. */
  nurses: readonly Nurse[];
  /** Matched against `abbreviation`, case-insensitively. */
  shiftTypes: readonly ShiftType[];
}

export interface HistoryCsvResult {
  rows: HistoricalShiftRow[];
  errors: HistoricalCsvError[];
}

/**
 * Parse a historical schedule spreadsheet: `employee_id,date,shift` plus whatever other
 * columns the manager's export happened to include. Header row required; column names are
 * matched case-insensitively after trimming, and column order and extra columns don't matter.
 */
export function parseHistoricalScheduleCsv(
  text: string,
  options: ParseHistoryOptions,
): HistoryCsvResult {
  const errors: HistoricalCsvError[] = [];
  const rows: HistoricalShiftRow[] = [];
  const table = parseCsv(text);
  const header = table[0];
  if (!header) return { rows, errors: [{ line: 1, message: 'File is empty' }] };

  const index = new Map<string, number>();
  header.forEach((name, i) => {
    index.set(name.trim().toLowerCase(), i);
  });
  const missing = HISTORY_COLUMNS.filter((c) => !index.has(c));
  if (missing.length > 0) {
    return {
      rows,
      errors: [{ line: 1, message: `Missing required column(s): ${missing.join(', ')}` }],
    };
  }

  const employeeIds = new Set(options.nurses.map((n) => n.employeeId));
  const abbreviationByLower = new Map<string, string>();
  for (const st of options.shiftTypes) {
    abbreviationByLower.set(st.abbreviation.trim().toLowerCase(), st.abbreviation);
  }

  // employeeId|date|abbreviation — exact-duplicate detection within this file.
  const seen = new Set<string>();

  for (let r = 1; r < table.length; r++) {
    const fields = table[r]!;
    const line = r + 1;
    if (fields.every((f) => f.trim() === '')) continue;

    const cell = (c: HistoryColumn): string => {
      const i = index.get(c);
      return i === undefined ? '' : (fields[i] ?? '').trim();
    };

    const employeeId = cell('employee_id');
    const dateRaw = cell('date');
    const shiftRaw = cell('shift');

    const rowErrors: HistoricalCsvError[] = [];

    if (!employeeId || !employeeIds.has(employeeId)) {
      rowErrors.push({ line, message: `Unknown employee id "${employeeId}"` });
    }

    let date: IsoDate | undefined;
    if (!isIsoDate(dateRaw)) {
      rowErrors.push({ line, message: `Date "${dateRaw}" is not a valid YYYY-MM-DD date` });
    } else {
      date = dateRaw;
    }

    const abbreviation = abbreviationByLower.get(shiftRaw.toLowerCase());
    if (!abbreviation) {
      rowErrors.push({ line, message: `Unknown shift abbreviation "${shiftRaw}"` });
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      continue;
    }

    const key = `${employeeId}|${date}|${abbreviation}`;
    if (seen.has(key)) {
      errors.push({
        line,
        message: `Duplicate: ${employeeId} already has ${abbreviation} on ${date}`,
      });
      continue;
    }
    seen.add(key);

    rows.push({ employeeId, date: date!, shiftAbbreviation: abbreviation! });
  }

  return { rows, errors };
}

export function formatHistoricalScheduleCsv(rows: readonly HistoricalShiftRow[]): string {
  const body = rows.map((r) => [r.employeeId, r.date, r.shiftAbbreviation]);
  return serializeCsv([[...HISTORY_COLUMNS], ...body]);
}

/**
 * Bucket imported rows into the unit's own pay periods (anchored on `unit.payPeriodAnchor`,
 * length `unit.payPeriodDays`) — the granularity the fairness ledger is kept at. `periodId` is
 * synthetic (`import:<start>`) because these periods predate any `SchedulePeriod` the app
 * generated; the id is derived only from the period's start date, so importing the same file
 * twice (e.g. a corrected re-export) lands on the same period ids rather than minting new ones.
 */
export function groupIntoPayPeriods(
  rows: readonly HistoricalShiftRow[],
  unit: Unit,
): HistoricalPeriod[] {
  const byIndex = new Map<number, HistoricalShiftRow[]>();
  for (const row of rows) {
    const idx = payPeriodIndex(row.date, unit);
    const bucket = byIndex.get(idx);
    if (bucket) bucket.push(row);
    else byIndex.set(idx, [row]);
  }

  const periods: HistoricalPeriod[] = [];
  for (const [idx, periodRows] of byIndex) {
    const window = payPeriodWindow(idx, unit);
    const sortedRows = [...periodRows].sort(
      (a, b) =>
        compareDates(a.date, b.date) ||
        a.employeeId.localeCompare(b.employeeId) ||
        a.shiftAbbreviation.localeCompare(b.shiftAbbreviation),
    );
    periods.push({
      periodId: `import:${window.start}`,
      start: window.start,
      end: window.end,
      rows: sortedRows,
    });
  }

  periods.sort((a, b) => compareDates(a.start, b.start));
  return periods;
}
