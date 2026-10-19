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
  today,
} from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { createShiftType, createUnit, listHolidaysForUnit, updateUnit } from './config.js';
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
import { nurseRecord } from './nurse-record.js';
import { createNurseUnit } from './nurse-units.js';
import { publishSchedule } from './publish.js';
import { createNurse, listPreferencesForNurse, replaceNursePreferences } from './roster.js';
import { saveRuleSet } from './rulesets.js';
import { archivePeriod, createAssignment, createPeriod } from './schedule.js';
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

/** A published, empty period with a manager-style name. */
function publishedPeriod(name: string, start: string, end: string): string {
  const period = createPeriod(
    handle.db,
    {
      unitId,
      name,
      startDate: isoDate(start),
      endDate: isoDate(end),
      ruleSetId,
      ruleSetVersion: 1,
    },
    ACTOR,
  );
  transact(handle.db, (tx) => publishSchedule(tx, { periodId: period.id }, ACTOR));
  return period.id;
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
  if (status === 'published')
    transact(handle.db, (tx) => publishSchedule(tx, { periodId: period.id }, ACTOR));
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

  it('refuses to move a holiday to another unit through an update', () => {
    const xmas = holiday('2026-12-25', 'Christmas Day', true);
    expect(() =>
      transact(handle.db, (tx) => updateHoliday(tx, xmas.id, { unitId: 'x' } as never, ACTOR)),
    ).toThrow(/cannot change 'unitId'/);
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

  it('lists the Christmas Eve night nurse as working Christmas when the unit counts by the clock', () => {
    const xmas = holiday('2025-12-25', 'Christmas Day', true);
    // 19:00 on the 24th to 07:00 on the 25th: seven hours of it are Christmas morning.
    const nightId = createShiftType(
      handle.db,
      {
        unitId,
        name: 'Night 12',
        abbreviation: 'N12',
        startTime: '19:00',
        durationHours: 12,
        isNight: true,
        isOnCall: false,
        color: '#1e3a8a',
        sortOrder: 2,
        active: true,
      },
      ACTOR,
    ).id;
    // The schedule goes out after the switch, so it counts by the clock.
    transact(handle.db, (tx) => updateUnit(tx, unitId, { holidayAttribution: 'clock' }, ACTOR));
    schedule('2025-12-21', '2026-01-03', 'published', [[ana, nightId, '2025-12-24']]);
    expect(holidayWorkIn(handle.db, unitId, ...window('2025-01-01', '2025-12-31'))).toEqual([
      { holidayId: xmas.id, nurseId: ana.id },
    ]);
  });

  it('reads by the unit’s own clock setting when only a draft covers the holiday', () => {
    const xmas = holiday('2025-12-25', 'Christmas Day', true);
    const nightId = createShiftType(
      handle.db,
      {
        unitId,
        name: 'Night 12',
        abbreviation: 'N12',
        startTime: '19:00',
        durationHours: 12,
        isNight: true,
        isOnCall: false,
        color: '#1e3a8a',
        sortOrder: 2,
        active: true,
      },
      ACTOR,
    ).id;
    // Christmas Eve's night went out on the schedule ending the 24th; Christmas itself is only
    // in a draft, so no published schedule says how Christmas is counted and the unit's does.
    schedule('2025-12-11', '2025-12-24', 'published', [[ana, nightId, '2025-12-24']]);
    transact(handle.db, (tx) => updateUnit(tx, unitId, { holidayAttribution: 'clock' }, ACTOR));
    schedule('2025-12-25', '2026-01-07', 'draft', []);
    expect(holidayWorkIn(handle.db, unitId, ...window('2025-01-01', '2025-12-31'))).toEqual([
      { holidayId: xmas.id, nurseId: ana.id },
    ]);
  });

  it('decides who worked last Christmas the way last Christmas’s schedule counted it', () => {
    holiday('2025-12-25', 'Christmas Day', true);
    const nightId = createShiftType(
      handle.db,
      {
        unitId,
        name: 'Night 12',
        abbreviation: 'N12',
        startTime: '19:00',
        durationHours: 12,
        isNight: true,
        isOnCall: false,
        color: '#1e3a8a',
        sortOrder: 2,
        active: true,
      },
      ACTOR,
    ).id;
    // Published under the start-day reading: a night dated the 24th is Christmas Eve's work.
    schedule('2025-12-21', '2026-01-03', 'published', [[ana, nightId, '2025-12-24']]);
    transact(handle.db, (tx) => updateUnit(tx, unitId, { holidayAttribution: 'clock' }, ACTOR));
    expect(holidayWorkIn(handle.db, unitId, ...window('2025-01-01', '2025-12-31'))).toEqual([]);
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
    expect(() => transact(handle.db, (tx) => addHolidayYear(tx, unitId, edited, ACTOR))).toThrow(
      /UNIQUE constraint failed: holiday.unit_id, holiday.date/,
    );
    expect(
      listHolidaysForUnit(handle.db, unitId)
        .map((h) => h.name)
        .sort(),
    ).toEqual(['Christmas Day', 'Independence Day']);
  });
});

describe('who can be recorded as working a holiday, and deleting one', () => {
  let zed: Nurse;

  beforeEach(() => {
    const east = createUnit(
      handle.db,
      {
        name: '5 East',
        unitType: 'Medical-Surgical',
        payPeriodDays: 14,
        payPeriodAnchor: isoDate('2026-01-04'),
      },
      ACTOR,
    ).id;
    zed = createNurse(
      handle.db,
      {
        unitId: east,
        employeeId: 'E9',
        firstName: 'Zed',
        lastName: 'Other',
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
  });

  const floatZed = (start: string, end: string) =>
    createNurseUnit(
      handle.db,
      { nurseId: zed.id, unitId, startDate: isoDate(start), endDate: isoDate(end) },
      ACTOR,
    );
  const REFUSAL =
    "Zed Other was not on 4 West's roster on 2025-12-25, so cannot be recorded as working Christmas Day.";

  it('refuses to record a nurse from another unit as working the holiday, and changes nothing', () => {
    const xmas = holiday('2025-12-25', 'Christmas Day', true);
    transact(handle.db, (tx) => recordHolidayWork(tx, xmas.id, [ana.id], ACTOR));
    expect(() =>
      transact(handle.db, (tx) => recordHolidayWork(tx, xmas.id, [ben.id, zed.id], ACTOR)),
    ).toThrow(REFUSAL);
    expect(holidayWorkSummary(handle.db, xmas.id).nurseIds).toEqual([ana.id]);
    expect(auditHistoryFor(handle.db, 'holiday_work', xmas.id)).toHaveLength(1);
  });

  it('records a nurse who floated to the unit over the holiday', () => {
    const xmas = holiday('2025-12-25', 'Christmas Day', true);
    floatZed('2025-12-01', '2026-01-31');
    const summary = transact(handle.db, (tx) => recordHolidayWork(tx, xmas.id, [zed.id], ACTOR));
    expect(summary.nurseIds).toEqual([zed.id]);
  });

  it('refuses a float whose time on the unit had ended before the holiday', () => {
    const xmas = holiday('2025-12-25', 'Christmas Day', true);
    floatZed('2025-11-01', '2025-12-24');
    expect(() =>
      transact(handle.db, (tx) => recordHolidayWork(tx, xmas.id, [zed.id], ACTOR)),
    ).toThrow(REFUSAL);
  });

  it('refuses a nurse id that is not on the roster at all, in words', () => {
    const xmas = holiday('2025-12-25', 'Christmas Day', true);
    expect(() =>
      transact(handle.db, (tx) => recordHolidayWork(tx, xmas.id, ['nobody'], ACTOR)),
    ).toThrow(
      'One of the nurses chosen is no longer on the roster. Reopen the list and choose again.',
    );
  });

  it("puts the holiday's date on who-worked entries, so a nurse's record says which day", () => {
    const xmas = holiday('2025-12-25', 'Christmas Day', true);
    transact(handle.db, (tx) => recordHolidayWork(tx, xmas.id, [ben.id], ACTOR));
    const newest = auditHistoryFor(handle.db, 'holiday_work', xmas.id)[0]!;
    expect(newest.after).toMatchObject({ date: '2025-12-25', nurseIds: [ben.id], recorded: true });
    const entry = nurseRecord(handle.db, ben.id, today(), today()).audit.find(
      (a) => a.entityType === 'holiday_work',
    );
    expect(entry?.concerns).toBe('2025-12-25');
  });

  it('refuses to delete a holiday whose who-worked list was recorded by hand, even an empty one', () => {
    const xmas = holiday('2025-12-25', 'Christmas Day', true);
    transact(handle.db, (tx) => recordHolidayWork(tx, xmas.id, [], ACTOR));
    expect(() => transact(handle.db, (tx) => deleteHoliday(tx, xmas.id, ACTOR))).toThrow(
      "Who worked Christmas Day on 2025-12-25 is recorded by hand, and next year's rotation reads that list. Clear the recorded list first (it stays in the audit log), then delete the holiday.",
    );
    expect(listHolidaysForUnit(handle.db, unitId).map((h) => h.id)).toContain(xmas.id);
    expect(holidayWorkSummary(handle.db, xmas.id).recorded).toBe(true);
  });

  it('deletes the holiday once the recorded list is cleared, with the list still in the audit log', () => {
    const xmas = holiday('2025-12-25', 'Christmas Day', true);
    transact(handle.db, (tx) => recordHolidayWork(tx, xmas.id, [ben.id], ACTOR));
    transact(handle.db, (tx) => clearHolidayWork(tx, xmas.id, ACTOR));
    transact(handle.db, (tx) => deleteHoliday(tx, xmas.id, ACTOR));
    expect(listHolidaysForUnit(handle.db, unitId).map((h) => h.id)).not.toContain(xmas.id);
    const [clear, record] = auditHistoryFor(handle.db, 'holiday_work', xmas.id);
    expect(clear!.before).toMatchObject({ nurseIds: [ben.id] });
    expect(record!.after).toMatchObject({ nurseIds: [ben.id] });
  });

  it("removes the nurses' wishes to work a deleted holiday, each on the record", () => {
    const xmas = holiday('2025-12-25', 'Christmas Day', true);
    const weekend = (nurseId: string) =>
      ({ id: `w-${nurseId}`, nurseId, kind: 'weekend_appetite', level: 1, weight: 1 }) as const;
    const wish = (nurseId: string) =>
      ({
        id: `h-${nurseId}`,
        nurseId,
        kind: 'holiday_appetite',
        holidayId: xmas.id,
        weight: 1,
      }) as const;
    transact(handle.db, (tx) =>
      replaceNursePreferences(tx, ana.id, [weekend(ana.id), wish(ana.id)], ACTOR),
    );
    transact(handle.db, (tx) => replaceNursePreferences(tx, ben.id, [wish(ben.id)], ACTOR));
    const prefAudits = (id: string) => auditHistoryFor(handle.db, 'preference', id);
    const anaBefore = prefAudits(ana.id).length;
    const benBefore = prefAudits(ben.id).length;

    transact(handle.db, (tx) => deleteHoliday(tx, xmas.id, ACTOR));

    expect(listPreferencesForNurse(handle.db, ana.id).map((p) => p.kind)).toEqual([
      'weekend_appetite',
    ]);
    expect(listPreferencesForNurse(handle.db, ben.id)).toEqual([]);
    expect(prefAudits(ana.id)).toHaveLength(anaBefore + 1);
    expect(prefAudits(ben.id)).toHaveLength(benBefore + 1);
    const a = prefAudits(ana.id)[0]!;
    expect([(a.before as unknown[]).length, (a.after as unknown[]).length]).toEqual([2, 1]);
    const b = prefAudits(ben.id)[0]!;
    expect([(b.before as unknown[]).length, (b.after as unknown[]).length]).toEqual([1, 0]);
  });
});

describe('moving a holiday to another date', () => {
  const move = (id: string, date: string, reason?: string) =>
    transact(handle.db, (tx) => updateHoliday(tx, id, { date: isoDate(date) }, ACTOR, reason));

  it('moves a future holiday without asking why', () => {
    const xmas = holiday('2026-12-25', 'Christmas Day', true);
    expect(move(xmas.id, '2026-12-26').date).toBe('2026-12-26');
    const entry = auditHistoryFor(handle.db, 'holiday', xmas.id)[0]!;
    expect(entry.action).toBe('update');
    expect((entry.before as Holiday).date).toBe('2026-12-25');
    expect((entry.after as Holiday).date).toBe('2026-12-26');
    expect(entry.reason).toBeUndefined();
  });

  it('needs a reason to move a holiday a published schedule covers', () => {
    const xmas = holiday('2026-12-25', 'Christmas Day', true);
    publishedPeriod('Dec 20 – Jan 2', '2026-12-20', '2027-01-02');
    const audits = auditHistoryFor(handle.db, 'holiday', xmas.id).length;
    expect(() => move(xmas.id, '2026-12-26')).toThrow(
      'Moving Christmas Day from 2026-12-25 to 2026-12-26 needs a reason: Dec 20 – Jan 2 is published, and the holiday rotation counts who worked Christmas Day from it.',
    );
    expect(listHolidaysForUnit(handle.db, unitId).find((h) => h.id === xmas.id)?.date).toBe(
      '2026-12-25',
    );
    expect(auditHistoryFor(handle.db, 'holiday', xmas.id)).toHaveLength(audits);

    move(xmas.id, '2026-12-26', 'Entered on the wrong day');
    const entry = auditHistoryFor(handle.db, 'holiday', xmas.id)[0]!;
    expect(entry.action).toBe('update');
    expect(entry.reason).toBe('Entered on the wrong day');
    expect((entry.before as Holiday).date).toBe('2026-12-25');
    expect((entry.after as Holiday).date).toBe('2026-12-26');
  });

  it('names both schedules when a published and an archived one cover the move', () => {
    const xmas = holiday('2026-12-25', 'Christmas Day', true);
    const older = publishedPeriod('Dec 20 – Jan 2', '2026-12-20', '2027-01-02');
    transact(handle.db, (tx) => archivePeriod(tx, older, ACTOR, 'Closed pay period'));
    publishedPeriod('Dec 26 – Jan 8', '2026-12-26', '2027-01-08');
    expect(() => move(xmas.id, '2026-12-26')).toThrow(
      'Moving Christmas Day from 2026-12-25 to 2026-12-26 needs a reason: Dec 20 – Jan 2, Dec 26 – Jan 8 are published, and the holiday rotation counts who worked Christmas Day from them.',
    );
  });

  it('needs a reason when only the new date is covered', () => {
    const thanks = holiday('2026-11-27', 'Thanksgiving Friday', false);
    publishedPeriod('Late Nov', '2026-11-29', '2026-12-12');
    expect(() => move(thanks.id, '2026-11-30')).toThrow(/needs a reason: Late Nov is published/);
  });

  it('refuses to put two holidays on one day', () => {
    const xmas = holiday('2026-12-25', 'Christmas Day', true);
    holiday('2026-12-24', 'Christmas Eve', false);
    expect(() => move(xmas.id, '2026-12-24')).toThrow(
      'Christmas Eve is already on 2026-12-24; a unit keeps one holiday a day.',
    );
  });

  it('keeps the hand-recorded list when the holiday moves', () => {
    const xmas = holiday('2026-12-25', 'Christmas Day', true);
    transact(handle.db, (tx) => recordHolidayWork(tx, xmas.id, [ana.id], ACTOR));
    move(xmas.id, '2026-12-26');
    const summary = holidayWorkSummary(handle.db, xmas.id);
    expect(summary.recorded).toBe(true);
    expect(summary.nurseIds).toEqual([ana.id]);
  });
});
