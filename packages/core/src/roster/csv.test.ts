import { describe, expect, it } from 'vitest';
import { isoDate } from '../domain/time.js';
import {
  formatRosterCsv,
  parseCsv,
  parseRosterCsv,
  ROSTER_COLUMNS,
  type RosterCsvRow,
  serializeCsv,
} from './csv.js';

describe('CSV parsing', () => {
  it('splits plain rows on commas and newlines', () => {
    expect(parseCsv('a,b,c\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('keeps a comma inside a quoted field — "Smith, Jr." stays one name', () => {
    expect(parseCsv('"Smith, Jr.",RN')).toEqual([['Smith, Jr.', 'RN']]);
  });

  it('unescapes doubled quotes the way Excel writes them', () => {
    expect(parseCsv('"She said ""hi""",x')).toEqual([['She said "hi"', 'x']]);
  });

  it('keeps a newline inside a quoted field', () => {
    expect(parseCsv('"line one\nline two",x')).toEqual([['line one\nline two', 'x']]);
  });

  it('accepts Windows line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('preserves empty fields, including a trailing one', () => {
    expect(parseCsv('a,,c\n1,2,')).toEqual([
      ['a', '', 'c'],
      ['1', '2', ''],
    ]);
  });

  it('ignores a UTF-8 byte-order mark Excel prepends', () => {
    expect(parseCsv('﻿a,b')).toEqual([['a', 'b']]);
  });

  it('round-trips through serializeCsv with quoting only where needed', () => {
    const rows = [
      ['plain', 'has,comma', 'has "quote"', 'has\nnewline', ''],
      ['1', '2', '3', '4', '5'],
    ];
    const text = serializeCsv(rows);
    expect(text).toBe('plain,"has,comma","has ""quote""","has\nnewline",\r\n1,2,3,4,5\r\n');
    expect(parseCsv(text)).toEqual(rows);
  });
});

const HEADER = ROSTER_COLUMNS.join(',');

function csv(...lines: string[]): string {
  return [HEADER, ...lines].join('\n');
}

describe('roster CSV import', () => {
  it('reads a complete full-time RN row', () => {
    const { rows, errors } = parseRosterCsv(
      csv(
        'E100,Ada,Okafor,RN,full_time,1.0,80,2015-03-02,yes,no,yes,555-0100,ada@x.org,,ACLS:2027-03-01;BLS',
      ),
      { payPeriodDays: 14 },
    );
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.nurse).toEqual({
      employeeId: 'E100',
      firstName: 'Ada',
      lastName: 'Okafor',
      role: 'RN',
      employmentType: 'full_time',
      fte: 1,
      contractedHoursPerPeriod: 80,
      seniorityDate: '2015-03-02',
      isChargeEligible: true,
      isNovice: false,
      isFloatEligible: true,
      phone: '555-0100',
      email: 'ada@x.org',
      notes: undefined,
    });
    expect(row.credentials).toEqual([
      { code: 'ACLS', expiresOn: '2027-03-01' },
      { code: 'BLS', expiresOn: undefined },
    ]);
  });

  it('derives contracted hours from FTE when the column is blank: 0.6 FTE over 14 days = 48h', () => {
    const { rows, errors } = parseRosterCsv(
      csv('E1,A,B,RN,part_time,0.6,,2020-01-01,no,no,no,,,,'),
      { payPeriodDays: 14 },
    );
    expect(errors).toEqual([]);
    expect(rows[0]!.nurse.contractedHoursPerPeriod).toBe(48);
  });

  it('reads Y/N, TRUE/FALSE and 1/0 as booleans, case-insensitively', () => {
    const { rows, errors } = parseRosterCsv(
      csv('E1,A,B,RN,full_time,1,80,2020-01-01,Y,FALSE,1,,,,'),
      { payPeriodDays: 14 },
    );
    expect(errors).toEqual([]);
    expect(rows[0]!.nurse.isChargeEligible).toBe(true);
    expect(rows[0]!.nurse.isNovice).toBe(false);
    expect(rows[0]!.nurse.isFloatEligible).toBe(true);
  });

  it('accepts columns in any order, matched by header name', () => {
    const text = [
      'last_name,first_name,employee_id,role,employment_type,fte,seniority_date',
      'Okafor,Ada,E100,RN,full_time,1,2015-03-02',
    ].join('\n');
    const { rows, errors } = parseRosterCsv(text, { payPeriodDays: 14 });
    expect(errors).toEqual([]);
    expect(rows[0]!.nurse.firstName).toBe('Ada');
    expect(rows[0]!.nurse.employeeId).toBe('E100');
    // Missing optional columns fall back: no flags, hours derived.
    expect(rows[0]!.nurse.isChargeEligible).toBe(false);
    expect(rows[0]!.nurse.contractedHoursPerPeriod).toBe(80);
  });

  it('reports each bad field with the spreadsheet line number and column, and keeps good rows', () => {
    const { rows, errors } = parseRosterCsv(
      csv(
        'E1,A,B,RN,full_time,1,80,2020-01-01,no,no,no,,,,',
        'E2,C,D,Doctor,full_time,1,80,2020-01-01,no,no,no,,,,',
        'E3,E,F,RN,full_time,abc,80,2020-02-30,no,no,no,,,,',
      ),
      { payPeriodDays: 14 },
    );
    expect(rows.map((r) => r.nurse.employeeId)).toEqual(['E1']);
    expect(errors).toEqual([
      { line: 3, column: 'role', message: expect.stringContaining('Doctor') },
      { line: 4, column: 'fte', message: expect.stringContaining('abc') },
      { line: 4, column: 'seniority_date', message: expect.stringContaining('2020-02-30') },
    ]);
  });

  it('rejects a duplicate employee id within the file — two rows cannot both be E1', () => {
    const { rows, errors } = parseRosterCsv(
      csv(
        'E1,A,B,RN,full_time,1,80,2020-01-01,no,no,no,,,,',
        'E1,C,D,RN,full_time,1,80,2020-01-01,no,no,no,,,,',
      ),
      { payPeriodDays: 14 },
    );
    expect(rows).toHaveLength(1);
    expect(errors).toEqual([
      { line: 3, column: 'employee_id', message: expect.stringContaining('E1') },
    ]);
  });

  it('fails the whole file when required headers are missing', () => {
    const { rows, errors } = parseRosterCsv('first_name,last_name\nAda,Okafor', {
      payPeriodDays: 14,
    });
    expect(rows).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.line).toBe(1);
    expect(errors[0]!.message).toContain('employee_id');
  });

  it('rejects an FTE outside 0–1.5 and a credential expiry that is not a date', () => {
    const { errors } = parseRosterCsv(
      csv('E1,A,B,RN,full_time,2,80,2020-01-01,no,no,no,,,,ACLS:soon'),
      { payPeriodDays: 14 },
    );
    expect(errors.map((e) => e.column)).toEqual(['fte', 'credentials']);
  });

  it('skips blank lines rather than reporting them as empty nurses', () => {
    const { rows, errors } = parseRosterCsv(
      csv('E1,A,B,RN,full_time,1,80,2020-01-01,no,no,no,,,,', '', '   '),
      { payPeriodDays: 14 },
    );
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
  });
});

describe('roster CSV export', () => {
  it('round-trips a roster through export and import unchanged', () => {
    const original: RosterCsvRow[] = [
      {
        nurse: {
          employeeId: 'E100',
          firstName: 'Ada',
          lastName: 'Okafor, Jr.',
          role: 'RN',
          employmentType: 'full_time',
          fte: 1,
          contractedHoursPerPeriod: 80,
          seniorityDate: isoDate('2015-03-02'),
          isChargeEligible: true,
          isNovice: false,
          isFloatEligible: true,
          phone: '555-0100',
          email: 'ada@x.org',
          notes: 'Prefers "nights"',
        },
        credentials: [
          { code: 'ACLS', expiresOn: isoDate('2027-03-01') },
          { code: 'BLS', expiresOn: undefined },
        ],
      },
      {
        nurse: {
          employeeId: 'E101',
          firstName: 'Bo',
          lastName: 'Lind',
          role: 'LPN',
          employmentType: 'per_diem',
          fte: 0.2,
          contractedHoursPerPeriod: 0,
          seniorityDate: isoDate('2024-11-30'),
          isChargeEligible: false,
          isNovice: true,
          isFloatEligible: false,
          phone: undefined,
          email: undefined,
          notes: undefined,
        },
        credentials: [],
      },
    ];
    const text = formatRosterCsv(original);
    expect(text.split('\r\n')[0]).toBe(HEADER);
    const { rows, errors } = parseRosterCsv(text, { payPeriodDays: 14 });
    expect(errors).toEqual([]);
    expect(rows).toEqual(original);
  });
});
