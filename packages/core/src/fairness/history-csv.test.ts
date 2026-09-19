import { describe, expect, it } from 'vitest';
import { isoDate } from '../domain/time.js';
import { makeNurse, resetFixtureCounters, testShiftTypes, testUnit } from '../testing/fixtures.js';
import {
  formatHistoricalScheduleCsv,
  groupIntoPayPeriods,
  HISTORY_COLUMNS,
  type ParseHistoryOptions,
  parseHistoricalScheduleCsv,
} from './history-csv.js';
import type { HistoricalShiftRow } from './types.js';

resetFixtureCounters();

// A stable two-nurse roster: E0001 (Nurse1 Test) and E0002 (Nurse2 Test).
const nurseA = makeNurse({ id: 'n-a', employeeId: 'E0001' });
const nurseB = makeNurse({ id: 'n-b', employeeId: 'E0002' });
const options: ParseHistoryOptions = { nurses: [nurseA, nurseB], shiftTypes: testShiftTypes };

const HEADER = HISTORY_COLUMNS.join(',');

function csv(...lines: string[]): string {
  return [HEADER, ...lines].join('\n');
}

describe('historical schedule CSV import', () => {
  it('rejects a file missing the shift column', () => {
    const { rows, errors } = parseHistoricalScheduleCsv(
      'employee_id,date\nE0001,2026-01-05',
      options,
    );
    expect(rows).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({ line: 1, message: expect.stringContaining('shift') });
  });

  it('names the line with an unknown employee id', () => {
    const { rows, errors } = parseHistoricalScheduleCsv(csv('E9999,2026-01-05,D12'), options);
    expect(rows).toEqual([]);
    expect(errors).toEqual([{ line: 2, message: expect.stringContaining('E9999') }]);
  });

  it('names the line with an invalid date', () => {
    const { rows, errors } = parseHistoricalScheduleCsv(csv('E0001,2026-02-30,D12'), options);
    expect(rows).toEqual([]);
    expect(errors).toEqual([{ line: 2, message: expect.stringContaining('2026-02-30') }]);
  });

  it('names the line with an unknown shift abbreviation', () => {
    const { rows, errors } = parseHistoricalScheduleCsv(csv('E0001,2026-01-05,ZZ'), options);
    expect(rows).toEqual([]);
    expect(errors).toEqual([{ line: 2, message: expect.stringContaining('ZZ') }]);
  });

  it('matches shift abbreviations regardless of case', () => {
    const { rows, errors } = parseHistoricalScheduleCsv(csv('E0001,2026-01-05,d12'), options);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { employeeId: 'E0001', date: isoDate('2026-01-05'), shiftAbbreviation: 'D12' },
    ]);
  });

  it('flags the same shift entered twice, on the later line', () => {
    const { rows, errors } = parseHistoricalScheduleCsv(
      csv('E0001,2026-01-05,D12', 'E0001,2026-01-05,D12'),
      options,
    );
    expect(rows).toHaveLength(1);
    expect(errors).toEqual([{ line: 3, message: expect.stringContaining('E0001') }]);
  });

  it('does not flag the same nurse on the same date in two different shifts', () => {
    // Not this parser's job to police double-booking — it just records what the sheet says.
    const { rows, errors } = parseHistoricalScheduleCsv(
      csv('E0001,2026-01-05,D12', 'E0001,2026-01-05,N12'),
      options,
    );
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
  });

  it('skips blank lines rather than reporting them as empty rows', () => {
    const { rows, errors } = parseHistoricalScheduleCsv(
      csv('E0001,2026-01-05,D12', '', '   '),
      options,
    );
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
  });

  it('matches columns case-insensitively and ignores extra columns', () => {
    const text = ['SHIFT,employee_id,Date,notes', 'D12,E0001,2026-01-05,covered a call-off'].join(
      '\n',
    );
    const { rows, errors } = parseHistoricalScheduleCsv(text, options);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { employeeId: 'E0001', date: isoDate('2026-01-05'), shiftAbbreviation: 'D12' },
    ]);
  });

  it('round-trips through format and parse', () => {
    const original: HistoricalShiftRow[] = [
      { employeeId: 'E0001', date: isoDate('2026-01-05'), shiftAbbreviation: 'D12' },
      { employeeId: 'E0002', date: isoDate('2026-01-06'), shiftAbbreviation: 'N8' },
    ];
    const text = formatHistoricalScheduleCsv(original);
    expect(text.split('\r\n')[0]).toBe(HEADER);
    const { rows, errors } = parseHistoricalScheduleCsv(text, options);
    expect(errors).toEqual([]);
    expect(rows).toEqual(original);
  });
});

describe('bucketing historical shifts into pay periods', () => {
  // testUnit: payPeriodDays 14, anchor 2026-01-04 (a Sunday). Period 0 is 2026-01-04..2026-01-17.
  it('buckets a shift on the last day of a pay period with that period, not the next', () => {
    const rows: HistoricalShiftRow[] = [
      { employeeId: 'E0001', date: isoDate('2026-01-17'), shiftAbbreviation: 'D12' }, // last day of period 0
      { employeeId: 'E0001', date: isoDate('2026-01-18'), shiftAbbreviation: 'D12' }, // first day of period 1
    ];
    const periods = groupIntoPayPeriods(rows, testUnit);
    expect(periods).toHaveLength(2);
    expect(periods[0]!.start).toBe('2026-01-04');
    expect(periods[0]!.end).toBe('2026-01-17');
    expect(periods[0]!.rows).toEqual([rows[0]]);
    expect(periods[1]!.start).toBe('2026-01-18');
    expect(periods[1]!.rows).toEqual([rows[1]]);
  });

  it('keeps period ids stable across two imports of the same dates', () => {
    const rows: HistoricalShiftRow[] = [
      { employeeId: 'E0001', date: isoDate('2026-01-05'), shiftAbbreviation: 'D12' },
    ];
    const first = groupIntoPayPeriods(rows, testUnit);
    const second = groupIntoPayPeriods(rows, testUnit);
    expect(first[0]!.periodId).toBe(second[0]!.periodId);
    expect(first[0]!.periodId).toBe('import:2026-01-04');
  });

  it('sorts periods by start date and rows within a period by date, then employee, then shift', () => {
    const rows: HistoricalShiftRow[] = [
      { employeeId: 'E0002', date: isoDate('2026-01-06'), shiftAbbreviation: 'N8' },
      { employeeId: 'E0001', date: isoDate('2026-01-05'), shiftAbbreviation: 'N12' },
      { employeeId: 'E0001', date: isoDate('2026-01-05'), shiftAbbreviation: 'D12' },
      { employeeId: 'E0001', date: isoDate('2026-01-18'), shiftAbbreviation: 'D12' },
    ];
    const periods = groupIntoPayPeriods(rows, testUnit);
    expect(periods.map((p) => p.start)).toEqual(['2026-01-04', '2026-01-18']);
    expect(periods[0]!.rows.map((r) => `${r.date}:${r.employeeId}:${r.shiftAbbreviation}`)).toEqual(
      ['2026-01-05:E0001:D12', '2026-01-05:E0001:N12', '2026-01-06:E0002:N8'],
    );
  });
});
