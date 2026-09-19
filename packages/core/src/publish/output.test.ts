import { describe, expect, it } from 'vitest';
import { parseHistoricalScheduleCsv } from '../fairness/history-csv.js';
import {
  assign,
  DAY_12,
  makeNurse,
  NIGHT_12,
  ON_CALL,
  resetFixtureCounters,
  scenario,
} from '../testing/fixtures.js';
import { buildGridSheet, buildNurseSheets, formatAssignmentsCsv, formatGridCsv } from './output.js';

function twoNurseWeek() {
  resetFixtureCounters();
  const ann = makeNurse({
    id: 'ann',
    firstName: 'Ann',
    lastName: 'Lee',
    employeeId: 'E1',
    role: 'RN',
  });
  const bo = makeNurse({
    id: 'bo',
    firstName: 'Bo',
    lastName: 'Kim',
    employeeId: 'E2',
    role: 'LPN',
  });
  const idle = makeNurse({ id: 'idle', firstName: 'Cy', lastName: 'Ng', employeeId: 'E3' });
  return scenario({
    startDate: '2026-01-04' as never,
    endDate: '2026-01-06' as never,
    nurses: [bo, ann, idle],
    assignments: [
      assign('ann', DAY_12, '2026-01-04', { isCharge: true }),
      assign('ann', NIGHT_12, '2026-01-06'),
      assign('bo', DAY_12, '2026-01-05'),
      assign('bo', ON_CALL, '2026-01-06'),
    ],
  });
}

describe('buildGridSheet', () => {
  it('lays nurses out alphabetically with one cell per day and the charge nurse marked', () => {
    const sheet = buildGridSheet(twoNurseWeek().schedule);
    expect(sheet.dates).toEqual(['2026-01-04', '2026-01-05', '2026-01-06']);
    expect(sheet.rows.map((r) => r.nurse.lastName)).toEqual(['Kim', 'Lee', 'Ng']);
    const ann = sheet.rows[1]!;
    expect(ann.cells.map((c) => c.map((s) => s.label))).toEqual([['D12*'], [], ['N12']]);
    expect(ann.hours).toBe(24);
    // On-call is standby, not worked hours: Bo has 12h worked and 12h on call.
    expect(sheet.rows[0]!.hours).toBe(12);
    expect(sheet.rows[0]!.onCallHours).toBe(12);
  });

  it('counts heads per shift per day for the footer so a thin day is visible on paper', () => {
    const sheet = buildGridSheet(twoNurseWeek().schedule);
    const day12 = sheet.dailyCounts.find((c) => c.shiftType.id === DAY_12.id)!;
    expect(day12.counts).toEqual([1, 1, 0]);
    // Shift types nobody works are not printed in the legend or the footer.
    expect(sheet.dailyCounts.map((c) => c.shiftType.abbreviation)).toEqual(['D12', 'N12', 'OC']);
  });
});

describe('buildNurseSheets', () => {
  it('gives each rostered nurse their own dated list with times and totals', () => {
    const sheets = buildNurseSheets(twoNurseWeek().schedule);
    expect(sheets.map((s) => s.nurse.id)).toEqual(['bo', 'ann']);
    const ann = sheets[1]!;
    expect(ann.shifts.map((s) => `${s.date} ${s.weekday} ${s.label} ${s.start}-${s.end}`)).toEqual([
      '2026-01-04 Sun D12 07:00-19:00',
      '2026-01-06 Tue N12 19:00-07:00',
    ]);
    expect(ann.shifts[0]!.isCharge).toBe(true);
    expect(ann.totalHours).toBe(24);
    expect(ann.contractedHours).toBe(72);
  });
});

describe('CSV output', () => {
  it('writes the grid with a header of dates and a hours column', () => {
    const csv = formatGridCsv(buildGridSheet(twoNurseWeek().schedule));
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('employee_id,name,role,2026-01-04,2026-01-05,2026-01-06,hours');
    expect(lines[2]).toBe('E1,"Lee, Ann",RN,D12*,,N12,24');
  });

  it('round-trips the long format through the history importer', () => {
    const s = twoNurseWeek();
    const csv = formatAssignmentsCsv(s.schedule);
    const parsed = parseHistoricalScheduleCsv(csv, { nurses: s.nurses, shiftTypes: s.shiftTypes });
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(4);
    // Kim sorts before Lee, so the file opens with Bo's Monday day shift.
    expect(parsed.rows[0]).toEqual({
      employeeId: 'E2',
      date: '2026-01-05',
      shiftAbbreviation: 'D12',
    });
  });
});
