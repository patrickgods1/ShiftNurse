import { describe, expect, it } from 'vitest';
import type { Nurse } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import type { RosterColumn, RosterCsvRow } from './csv.js';
import { OPTIONAL_ROSTER_COLUMNS, planRosterImport, rosterChangesFor } from './import-plan.js';

const REQUIRED: RosterColumn[] = [
  'employee_id',
  'first_name',
  'last_name',
  'role',
  'employment_type',
  'fte',
  'seniority_date',
];

const ana: Nurse = {
  id: 'n-ana',
  unitId: 'unit-1',
  employeeId: 'E1',
  firstName: 'Ana',
  lastName: 'Cruz',
  role: 'RN',
  employmentType: 'full_time',
  fte: 0.9,
  contractedHoursPerPeriod: 72,
  seniorityDate: isoDate('2020-01-01'),
  scheduleKind: 'va_72_80',
  isChargeEligible: true,
  isNovice: false,
  isFloatEligible: false,
  notes: 'Prefers nights',
  active: true,
};

/** Ana's row as the parser reads it from a sheet of the seven required columns only. */
function anaRow(overrides: Partial<RosterCsvRow['nurse']> = {}): RosterCsvRow {
  return {
    nurse: {
      employeeId: 'E1',
      firstName: 'Ana',
      lastName: 'Cruz',
      role: 'RN',
      employmentType: 'full_time',
      fte: 0.9,
      // What the parser derives from 0.9 FTE over 14 days: 0.9 x 40 x 2 = 72.
      contractedHoursPerPeriod: 72,
      seniorityDate: isoDate('2020-01-01'),
      isChargeEligible: false,
      isNovice: false,
      isFloatEligible: false,
      phone: undefined,
      email: undefined,
      notes: undefined,
      ...overrides,
    },
    credentials: [],
  };
}

describe('what a roster import changes', () => {
  it('leaves the schedule plan, notes and charge flag alone when the sheet has no such columns', () => {
    expect(rosterChangesFor(ana, anaRow(), REQUIRED)).toEqual({});
    expect(planRosterImport([ana], [anaRow()], REQUIRED)).toEqual([
      { employeeId: 'E1', name: 'Cruz, Ana', action: 'unchanged', inactive: false, changes: [] },
    ]);
  });

  it('clears notes when the column is there but the cell is blank, and says so', () => {
    const columns: RosterColumn[] = [...REQUIRED, 'notes'];
    expect(rosterChangesFor(ana, anaRow(), columns)).toEqual({ notes: null });
    const [plan] = planRosterImport([ana], [anaRow()], columns);
    expect(plan).toEqual({
      employeeId: 'E1',
      name: 'Cruz, Ana',
      action: 'update',
      inactive: false,
      changes: [{ field: 'Notes', from: 'Prefers nights', to: undefined }],
    });
  });

  it("lists a plan change in the manager's words", () => {
    const columns: RosterColumn[] = [...REQUIRED, 'schedule_kind'];
    expect(rosterChangesFor(ana, anaRow(), columns)).toEqual({ scheduleKind: null });
    expect(planRosterImport([ana], [anaRow()], columns)[0]!.changes).toEqual([
      { field: 'Schedule plan', from: 'VA 72/80 (38 U.S.C. § 7456A)', to: undefined },
    ]);
  });

  it('turns a charge flag off only when the column says no', () => {
    const present: RosterColumn[] = [...REQUIRED, 'charge_eligible', 'novice', 'float_eligible'];
    expect(rosterChangesFor(ana, anaRow(), present)).toEqual({ isChargeEligible: false });
    expect(planRosterImport([ana], [anaRow()], present)[0]!.changes).toEqual([
      { field: 'Charge eligible', from: 'yes', to: 'no' },
    ]);
    expect(planRosterImport([ana], [anaRow()], REQUIRED)[0]!.changes).toEqual([]);
  });

  it('marks a nurse who left as inactive without deciding to bring her back', () => {
    const departed: Nurse = { ...ana, active: false };
    expect(rosterChangesFor(departed, anaRow(), REQUIRED)).toEqual({});
    expect(planRosterImport([departed], [anaRow()], REQUIRED)).toEqual([
      { employeeId: 'E1', name: 'Cruz, Ana', action: 'unchanged', inactive: true, changes: [] },
    ]);
  });

  it('plans a nurse not on the unit as new', () => {
    const newcomer = anaRow({ employeeId: 'E9', firstName: 'Bo', lastName: 'Lee' });
    expect(planRosterImport([ana], [newcomer], REQUIRED)).toEqual([
      { employeeId: 'E9', name: 'Lee, Bo', action: 'create', inactive: false, changes: [] },
    ]);
  });

  it('keeps hours agreed with the nurse when the sheet has no hours column', () => {
    // Ana's contract says 76 h; a sheet without the column derives 72 from her FTE.
    const agreed: Nurse = { ...ana, contractedHoursPerPeriod: 76 };
    expect(rosterChangesFor(agreed, anaRow(), REQUIRED)).toEqual({});
    const columns: RosterColumn[] = [...REQUIRED, 'contracted_hours_per_period'];
    expect(rosterChangesFor(agreed, anaRow(), columns)).toEqual({ contractedHoursPerPeriod: 72 });
    expect(planRosterImport([agreed], [anaRow()], columns)[0]!.changes).toEqual([
      { field: 'Contracted hours', from: '76', to: '72' },
    ]);
  });

  it('keeps her scheduled days when the cell is blank, and changes them when it is filled', () => {
    const threeTwelves: Nurse = { ...ana, scheduledDaysPerWeek: 3 };
    const columns: RosterColumn[] = [...REQUIRED, 'scheduled_days_per_week'];
    expect(rosterChangesFor(threeTwelves, anaRow(), columns)).toEqual({});
    expect(rosterChangesFor(threeTwelves, anaRow({ scheduledDaysPerWeek: 4 }), columns)).toEqual({
      scheduledDaysPerWeek: 4,
    });
    expect(rosterChangesFor(threeTwelves, anaRow({ scheduledDaysPerWeek: 4 }), REQUIRED)).toEqual(
      {},
    );
  });

  it('records a new phone number and a hire date only when the sheet carries them', () => {
    const row = anaRow({ phone: '555-0100', hireDate: isoDate('2018-06-04') });
    expect(rosterChangesFor(ana, row, REQUIRED)).toEqual({});
    const columns: RosterColumn[] = [...REQUIRED, 'phone', 'email', 'hire_date'];
    expect(rosterChangesFor(ana, row, columns)).toEqual({
      phone: '555-0100',
      hireDate: '2018-06-04',
    });
    expect(planRosterImport([ana], [row], columns)[0]!.changes).toEqual([
      { field: 'Hire date', from: undefined, to: '2018-06-04' },
      { field: 'Phone', from: undefined, to: '555-0100' },
    ]);
  });

  it('shows a married name and a move to part time as the manager would say them', () => {
    const row = anaRow({ lastName: 'Cruz-Lee', employmentType: 'part_time', fte: 0.6 });
    expect(rosterChangesFor(ana, row, REQUIRED)).toEqual({
      lastName: 'Cruz-Lee',
      employmentType: 'part_time',
      fte: 0.6,
    });
    expect(planRosterImport([ana], [row], REQUIRED)[0]).toEqual({
      employeeId: 'E1',
      name: 'Cruz-Lee, Ana',
      action: 'update',
      inactive: false,
      changes: [
        { field: 'Last name', from: 'Cruz', to: 'Cruz-Lee' },
        { field: 'Employment', from: 'Full time', to: 'Part time' },
        { field: 'FTE', from: '0.9', to: '0.6' },
      ],
    });
  });

  it('counts every column but the seven required ones as optional', () => {
    expect(OPTIONAL_ROSTER_COLUMNS).toEqual([
      'contracted_hours_per_period',
      'charge_eligible',
      'novice',
      'float_eligible',
      'phone',
      'email',
      'notes',
      'credentials',
      'hire_date',
      'schedule_kind',
      'scheduled_days_per_week',
    ]);
  });
});
