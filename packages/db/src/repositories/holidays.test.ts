/**
 * Holidays as the rotation needs them: grouped major/minor, paired within a season, and a
 * record of who worked each one. A pairing the rotation cannot honour is refused by name; who
 * worked comes from published schedules until the manager records it by hand.
 */

import {
  DEFAULT_FAIRNESS_WEIGHTS,
  DEFAULT_WEEKEND,
  type Holiday,
  type IsoDate,
  isoDate,
  type Nurse,
  planHolidayYear,
} from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { createShiftType, createUnit, listHolidaysForUnit } from './config.js';
import {
  addHolidayYear,
  clearHolidayWork,
  createHoliday,
  deleteHoliday,
  holidayWorkIn,
  holidayWorkSummary,
  recordHolidayWork,
  updateHoliday,
} from './holidays.js';
import { createNurse } from './roster.js';
import { saveRuleSet } from './rulesets.js';
import { createAssignment, createPeriod, updatePeriodStatus } from './schedule.js';
import { holidayWorkForPeriod } from './solve-input.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let ruleSetId: string;
let dayId: string;
let onCallId: string;
let ana: Nurse;
let ben: Nurse;

function nurse(n: number, first: string): Nurse {
  return createNurse(
    handle.db,
    {
      unitId,
      employeeId: `E${n}`,
      firstName: first,
      lastName: 'Test',
      role: 'RN',
      employmentType: 'full_time',
      fte: 1,
      contractedHoursPerPeriod: 72,
      seniorityDate: isoDate('2020-01-01'),
      isChargeEligible: false,
      isNovice: false,
      isFloatEligible: true,
      active: true,
    },
    ACTOR,
  );
}

function shift(name: string, isOnCall: boolean): string {
  return createShiftType(
    handle.db,
    {
      unitId,
      name,
      abbreviation: name.slice(0, 3),
      startTime: '07:00',
      durationHours: 12,
      isNight: false,
      isOnCall,
      color: '#f59e0b',
      sortOrder: 1,
      active: true,
    },
    ACTOR,
  ).id;
}

function holiday(date: string, name: string, isMajor: boolean, pairedHolidayId?: string): Holiday {
  return createHoliday(
    handle.db,
    { unitId, date: isoDate(date), name, isMajor, pairedHolidayId: pairedHolidayId ?? null },
    ACTOR,
  );
}

/** A schedule period holding these shifts, left as a draft or published. */
function schedule(
  start: string,
  end: string,
  status: 'draft' | 'published',
  shifts: [Nurse, string, string][],
): void {
  const period = createPeriod(
    handle.db,
    {
      unitId,
      name: `${start} to ${end}`,
      startDate: isoDate(start),
      endDate: isoDate(end),
      ruleSetId,
      ruleSetVersion: 1,
    },
    ACTOR,
  );
  for (const [n, shiftTypeId, date] of shifts) {
    createAssignment(
      handle.db,
      { periodId: period.id, nurseId: n.id, shiftTypeId, date: isoDate(date) },
      ACTOR,
    );
  }
  if (status === 'published') updatePeriodStatus(handle.db, period.id, 'published', ACTOR);
}

beforeEach(() => {
  handle = openTestDatabase();
  unitId = createUnit(
    handle.db,
    {
      name: '4 West',
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  ).id;
  ruleSetId = transact(handle.db, (tx) =>
    saveRuleSet(
      tx,
      {
        unitId,
        name: 'Default',
        weekendDefinition: DEFAULT_WEEKEND,
        fairnessWeights: DEFAULT_FAIRNESS_WEIGHTS,
        configs: [],
      },
      ACTOR,
    ),
  ).id;
  dayId = shift('Day 12', false);
  onCallId = shift('On call', true);
  ana = nurse(1, 'Ana');
  ben = nurse(2, 'Ben');
});

afterEach(() => handle.close());

describe('pairing a minor holiday with a major one', () => {
  it('pairs Christmas Eve with Christmas Day', () => {
    const xmas = holiday('2026-12-25', 'Christmas Day', true);
    const eve = holiday('2026-12-24', 'Christmas Eve', false, xmas.id);
    expect(eve.pairedHolidayId).toBe(xmas.id);
  });

  it('refuses to pair with a minor holiday', () => {
    const boxing = holiday('2026-12-26', 'Boxing Day', false);
    expect(() => holiday('2026-12-24', 'Christmas Eve', false, boxing.id)).toThrow(
      /Boxing Day is not a major holiday/,
    );
  });

  it('pairs holidays months apart, as the manager chooses', () => {
    const thanksgiving = holiday('2026-11-26', 'Thanksgiving Day', true);
    const memorial = holiday('2026-05-25', 'Memorial Day', false, thanksgiving.id);
    expect(memorial.pairedHolidayId).toBe(thanksgiving.id);
  });

  it('never pairs a major holiday', () => {
    const xmas = holiday('2026-12-25', 'Christmas Day', true);
    const ny = holiday('2027-01-01', "New Year's Day", true);
    const updated = transact(handle.db, (tx) =>
      updateHoliday(tx, ny.id, { pairedHolidayId: xmas.id }, ACTOR),
    );
    expect(updated.pairedHolidayId).toBeNull();
  });
});

describe('moving a holiday between major and minor', () => {
  it('makes Christmas Eve major, dropping its pairing', () => {
    const xmas = holiday('2026-12-25', 'Christmas Day', true);
    const eve = holiday('2026-12-24', 'Christmas Eve', false, xmas.id);
    const updated = transact(handle.db, (tx) =>
      updateHoliday(tx, eve.id, { isMajor: true }, ACTOR),
    );
    expect(updated).toMatchObject({ isMajor: true, pairedHolidayId: null });
  });

  it('unpairs the minors of a major made minor, and audits each', () => {
    const xmas = holiday('2026-12-25', 'Christmas Day', true);
    const eve = holiday('2026-12-24', 'Christmas Eve', false, xmas.id);
    transact(handle.db, (tx) => updateHoliday(tx, xmas.id, { isMajor: false }, ACTOR));
    const byId = new Map(listHolidaysForUnit(handle.db, unitId).map((h) => [h.id, h]));
    expect(byId.get(xmas.id)?.isMajor).toBe(false);
    expect(byId.get(eve.id)?.pairedHolidayId).toBeNull();
    // Newest first: the unpairing, then the creation.
    expect(auditHistoryFor(handle.db, 'holiday', eve.id).map((e) => e.action)).toEqual([
      'update',
      'create',
    ]);
  });

  it('refuses to change the date or unit through an update', () => {
    const xmas = holiday('2026-12-25', 'Christmas Day', true);
    expect(() =>
      transact(handle.db, (tx) =>
        updateHoliday(tx, xmas.id, { date: '2026-12-26' } as never, ACTOR),
      ),
    ).toThrow(/cannot change 'date'/);
  });

  it('unpairs a minor holiday when its major is deleted', () => {
    const xmas = holiday('2026-12-25', 'Christmas Day', true);
    const eve = holiday('2026-12-24', 'Christmas Eve', false, xmas.id);
    transact(handle.db, (tx) => deleteHoliday(tx, xmas.id, ACTOR));
    expect(
      listHolidaysForUnit(handle.db, unitId).find((h) => h.id === eve.id)?.pairedHolidayId,
    ).toBeNull();
    // The unpairing is on the record, not left to the foreign key: newest first.
    const history = auditHistoryFor(handle.db, 'holiday', eve.id);
    expect(history.map((e) => e.action)).toEqual(['update', 'create']);
    expect(history[0]?.after).toMatchObject({ pairedHolidayId: null });
  });
});

describe('who worked a holiday', () => {
  const window = (start: string, end: string): [IsoDate, IsoDate] => [isoDate(start), isoDate(end)];

  it('reads published schedules, ignoring drafts and standby', () => {
    const xmas = holiday('2025-12-25', 'Christmas Day', true);
    schedule('2025-12-21', '2026-01-03', 'published', [
      [ana, dayId, '2025-12-25'],
      [ben, onCallId, '2025-12-25'],
    ]);
    schedule('2025-12-21', '2026-01-03', 'draft', [[ben, dayId, '2025-12-25']]);
    expect(holidayWorkIn(handle.db, unitId, ...window('2025-01-01', '2025-12-31'))).toEqual([
      { holidayId: xmas.id, nurseId: ana.id },
    ]);
  });

  it('uses a list recorded by hand instead, for a year before the app', () => {
    const xmas = holiday('2025-12-25', 'Christmas Day', true);
    schedule('2025-12-21', '2026-01-03', 'published', [[ana, dayId, '2025-12-25']]);
    transact(handle.db, (tx) => recordHolidayWork(tx, xmas.id, [ben.id], ACTOR));
    expect(holidayWorkIn(handle.db, unitId, ...window('2025-01-01', '2025-12-31'))).toEqual([
      { holidayId: xmas.id, nurseId: ben.id },
    ]);
    expect(holidayWorkSummary(handle.db, xmas.id)).toEqual({
      holidayId: xmas.id,
      recorded: true,
      nurseIds: [ben.id],
      fromSchedules: [ana.id],
    });
  });

  it('treats an empty recorded list as "nobody", not as "look at the schedules"', () => {
    const xmas = holiday('2025-12-25', 'Christmas Day', true);
    schedule('2025-12-21', '2026-01-03', 'published', [[ana, dayId, '2025-12-25']]);
    transact(handle.db, (tx) => recordHolidayWork(tx, xmas.id, [], ACTOR));
    expect(holidayWorkIn(handle.db, unitId, ...window('2025-01-01', '2025-12-31'))).toEqual([]);
  });

  it('goes back to the schedules when the recorded list is cleared, audited both ways', () => {
    const xmas = holiday('2025-12-25', 'Christmas Day', true);
    schedule('2025-12-21', '2026-01-03', 'published', [[ana, dayId, '2025-12-25']]);
    transact(handle.db, (tx) => recordHolidayWork(tx, xmas.id, [ben.id], ACTOR));
    transact(handle.db, (tx) => clearHolidayWork(tx, xmas.id, ACTOR));
    expect(holidayWorkSummary(handle.db, xmas.id).nurseIds).toEqual([ana.id]);
    expect(auditHistoryFor(handle.db, 'holiday_work', xmas.id)).toHaveLength(2);
  });

  it('loads who worked Memorial Day for a November period pairing it with Thanksgiving', () => {
    const thanksgiving = holiday('2026-11-26', 'Thanksgiving Day', true);
    const memorial = holiday('2026-05-25', 'Memorial Day', false, thanksgiving.id);
    schedule('2026-05-24', '2026-06-06', 'published', [[ana, dayId, '2026-05-25']]);
    const november = {
      id: 'p',
      unitId,
      name: 'November',
      startDate: isoDate('2026-11-22'),
      endDate: isoDate('2026-12-05'),
      status: 'draft' as const,
      ruleSetId,
      ruleSetVersion: 1,
    };
    expect(holidayWorkForPeriod(handle.db, november)).toEqual([
      { holidayId: memorial.id, nurseId: ana.id },
    ]);
  });
});

describe('adding a year of holidays', () => {
  it('saves next year from last year, with Christmas Eve paired to the new Christmas Day', () => {
    const xmas = holiday('2026-12-25', 'Christmas Day', true);
    holiday('2026-12-24', 'Christmas Eve', false, xmas.id);
    holiday('2026-11-26', 'Thanksgiving Day', true);
    const plan = planHolidayYear(listHolidaysForUnit(handle.db, unitId), 2027);
    const added = transact(handle.db, (tx) => addHolidayYear(tx, unitId, plan, ACTOR));
    expect(added.map((h) => [h.date, h.name])).toEqual([
      ['2027-11-25', 'Thanksgiving Day'],
      ['2027-12-24', 'Christmas Eve'],
      ['2027-12-25', 'Christmas Day'],
    ]);
    const eve = added.find((h) => h.name === 'Christmas Eve')!;
    expect(eve.pairedHolidayId).toBe(added.find((h) => h.name === 'Christmas Day')!.id);
  });

  it('pairs last New Year’s Eve with the New Year’s Day it adds', () => {
    const nyd26 = holiday('2026-01-01', "New Year's Day", true);
    holiday('2025-12-31', "New Year's Eve", false, nyd26.id);
    const nye26 = holiday('2026-12-31', "New Year's Eve", false);
    const plan = planHolidayYear(listHolidaysForUnit(handle.db, unitId), 2027);
    const added = transact(handle.db, (tx) => addHolidayYear(tx, unitId, plan, ACTOR));
    const nyd27 = added.find((h) => h.name === "New Year's Day")!;
    const after = listHolidaysForUnit(handle.db, unitId).find((h) => h.id === nye26.id);
    expect(after?.pairedHolidayId).toBe(nyd27.id);
  });

  it('saves nothing when one holiday cannot be added', () => {
    holiday('2026-12-25', 'Christmas Day', true);
    const plan = planHolidayYear(listHolidaysForUnit(handle.db, unitId), 2027);
    // The manager edits a date onto one already taken.
    holiday('2027-07-04', 'Independence Day', true);
    const edited = {
      ...plan,
      holidays: plan.holidays.map((h) => ({ ...h, date: isoDate('2027-07-04') })),
    };
    expect(() => transact(handle.db, (tx) => addHolidayYear(tx, unitId, edited, ACTOR))).toThrow();
    expect(
      listHolidaysForUnit(handle.db, unitId)
        .map((h) => h.name)
        .sort(),
    ).toEqual(['Christmas Day', 'Independence Day']);
  });
});
