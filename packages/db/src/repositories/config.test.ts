/**
 * Which unit the app opens. A VA install has a float sibling beside its home unit, and picking
 * "the unit" by alphabetical order once switched the whole app to the sibling the moment the
 * manager renamed the home unit so that it sorted second.
 */

import {
  DEFAULT_FAIRNESS_WEIGHTS,
  type Id,
  type IsoDate,
  isoDate,
  type PaperSize,
  type Unit,
} from '@shiftnurse/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor, recentAudit } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { unit as unitTable } from '../schema.js';
import { listCensusHistory, upsertCensusForecast } from './census.js';
import {
  createShiftCredentialRequirement,
  createShiftType,
  createUnit,
  deactivateShiftType,
  duplicateShiftType,
  fillCoverageWeek,
  getHomeUnit,
  listCoverageRequirementsForUnit,
  listShiftCredentialRequirementsForUnit,
  listShiftTypesForUnit,
  listUnits,
  lockedShiftTypeIds,
  updateShiftType,
  updateUnit,
  upsertCoverageRequirement,
} from './config.js';
import { publishSchedule, recordScheduleChange } from './publish.js';
import { createNurse, listPreferencesForNurse, replaceNursePreferences } from './roster.js';
import { createCredential } from './roster-io.js';
import { saveRuleSet } from './rulesets.js';
import {
  archivePeriod,
  createAssignment,
  createPeriod,
  deleteAssignment,
  listAssignmentsForPeriod,
} from './schedule.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;

beforeEach(() => {
  handle = openTestDatabase();
});

afterEach(() => {
  handle.close();
});

function addUnit(name: string): Unit {
  return createUnit(
    handle.db,
    {
      name,
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  );
}

describe('the home unit', () => {
  it('is the first unit created, whatever it is later called', () => {
    const home = addUnit('4A Medicine-Surgery');
    addUnit('4B Telemetry');
    updateUnit(handle.db, home.id, { name: 'Medicine-Surgery 4A' }, ACTOR);

    expect(listUnits(handle.db)[0]!.name).toBe('4B Telemetry');
    expect(getHomeUnit(handle.db)!.name).toBe('Medicine-Surgery 4A');
  });

  it('refuses a second home unit', () => {
    addUnit('4A Medicine-Surgery');
    const b = addUnit('4B Telemetry');
    expect(() =>
      handle.db.update(unitTable).set({ isHome: true }).where(eq(unitTable.id, b.id)).run(),
    ).toThrow(/UNIQUE constraint/);
  });

  it('an empty database has no home unit', () => {
    expect(getHomeUnit(handle.db)).toBeUndefined();
  });
});

describe('coverage floors', () => {
  it('writes no audit row when a coverage floor is saved unchanged', () => {
    const home = addUnit('4A Medicine-Surgery');
    const day = createShiftType(
      handle.db,
      {
        unitId: home.id,
        name: 'Day',
        abbreviation: 'D',
        startTime: '07:00',
        durationHours: 12,
        isNight: false,
        isOnCall: false,
        color: '#ffffff',
        sortOrder: 1,
        active: true,
      },
      ACTOR,
    );
    const floor = {
      unitId: home.id,
      shiftTypeId: day.id,
      weekday: 1 as const,
      date: null,
      role: 'RN' as const,
      minCount: 3,
      targetCount: 6,
    };
    const created = upsertCoverageRequirement(handle.db, floor, ACTOR);
    const rows = () => auditHistoryFor(handle.db, 'coverage_requirement', created.id);
    expect(rows()).toHaveLength(1);

    const same = upsertCoverageRequirement(handle.db, { ...floor, id: created.id }, ACTOR);
    expect(same).toEqual(created);
    expect(rows()).toHaveLength(1);

    upsertCoverageRequirement(handle.db, { ...floor, id: created.id, minCount: 4 }, ACTOR);
    expect(rows()).toHaveLength(2);
    expect((rows()[0]!.before as { minCount: number }).minCount).toBe(3);
  });

  describe('Same all week', () => {
    function weekSetup() {
      const home = addUnit('4A Medicine-Surgery');
      const day = createShiftType(
        handle.db,
        {
          unitId: home.id,
          name: 'Day',
          abbreviation: 'D',
          startTime: '07:00',
          durationHours: 12,
          isNight: false,
          isOnCall: false,
          color: '#ffffff',
          sortOrder: 1,
          active: true,
        },
        ACTOR,
      );
      // Sunday 4/4; Monday, Tuesday, Thursday, Friday and Saturday 3/3; no Wednesday.
      for (const weekday of [0, 1, 2, 4, 5, 6] as const) {
        const n = weekday === 0 ? 4 : 3;
        upsertCoverageRequirement(
          handle.db,
          {
            unitId: home.id,
            shiftTypeId: day.id,
            weekday,
            date: null,
            role: 'RN',
            minCount: n,
            targetCount: n,
          },
          ACTOR,
        );
      }
      return { home, day };
    }

    it('fills the week in one go, rewriting only the days that change', () => {
      const { home, day } = weekSetup();
      const auditBefore = recentAudit(handle.db, 1000).length;

      const filled = transact(handle.db, (tx) =>
        fillCoverageWeek(
          tx,
          { unitId: home.id, shiftTypeId: day.id, role: 'RN', minCount: 4, targetCount: 4 },
          ACTOR,
        ),
      );

      expect(filled.map((r) => r.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      const stored = listCoverageRequirementsForUnit(handle.db, home.id);
      expect(stored).toHaveLength(7);
      expect(stored.map((r) => `${r.minCount}/${r.targetCount}`)).toEqual(Array(7).fill('4/4'));
      // Five updates (Mon, Tue, Thu, Fri, Sat) and one create (Wed); Sunday was already 4/4.
      expect(recentAudit(handle.db, 1000).length - auditBefore).toBe(6);
    });

    it('refuses a week whose target is below its minimum, writing nothing', () => {
      const { home, day } = weekSetup();
      const auditBefore = recentAudit(handle.db, 1000).length;

      expect(() =>
        transact(handle.db, (tx) =>
          fillCoverageWeek(
            tx,
            { unitId: home.id, shiftTypeId: day.id, role: 'RN', minCount: 5, targetCount: 4 },
            ACTOR,
          ),
        ),
      ).toThrow('The target cannot be below the minimum.');

      expect(listCoverageRequirementsForUnit(handle.db, home.id)).toHaveLength(6);
      expect(recentAudit(handle.db, 1000).length).toBe(auditBefore);
    });

    it('refuses half a nurse before writing anything', () => {
      const { home, day } = weekSetup();
      expect(() =>
        transact(handle.db, (tx) =>
          fillCoverageWeek(
            tx,
            { unitId: home.id, shiftTypeId: day.id, role: 'RN', minCount: 2.5, targetCount: 3 },
            ACTOR,
          ),
        ),
      ).toThrow('Coverage counts must be whole numbers, zero or more.');
    });
  });
});

describe('one coverage floor per shift, role and day', () => {
  function twoUnits() {
    const west = addUnit('4 West');
    const east = addUnit('5 East');
    const shift = (unitId: string, name: string) =>
      createShiftType(
        handle.db,
        {
          unitId,
          name,
          abbreviation: name[0]!,
          startTime: '07:00',
          durationHours: 12,
          isNight: false,
          isOnCall: false,
          color: '#ffffff',
          sortOrder: 1,
          active: true,
        },
        ACTOR,
      );
    const day = shift(west.id, 'Day 12');
    const night = shift(east.id, 'Night 12');
    const floor = (over: Partial<Parameters<typeof upsertCoverageRequirement>[1]> = {}) => ({
      unitId: west.id,
      shiftTypeId: day.id,
      weekday: 1 as 0 | 1 | 2 | 3 | 4 | 5 | 6 | null,
      date: null as IsoDate | null,
      role: 'RN' as const,
      minCount: 3,
      targetCount: 3,
      ...over,
    });
    const save = (over: Parameters<typeof floor>[0] = {}) =>
      upsertCoverageRequirement(handle.db, floor(over), ACTOR);
    return { west, east, day, night, floor, save };
  }

  it('refuses a second RN floor for Day 12 on Mondays', () => {
    const { west, save } = twoUnits();
    save();
    expect(() => save({ minCount: 5, targetCount: 5 })).toThrow(
      'Day 12 already has an RN floor for Mondays; change that one instead.',
    );
    const stored = listCoverageRequirementsForUnit(handle.db, west.id);
    expect(stored.map((r) => `${r.minCount}/${r.targetCount}`)).toEqual(['3/3']);
  });

  it('refuses a second Christmas override for the same shift and role', () => {
    const { save } = twoUnits();
    // 2026-01-01 is a Thursday and Dec 25 is 358 days later; 358 mod 7 = 1, so a Friday.
    save({ weekday: null, date: isoDate('2026-12-25') });
    expect(() => save({ weekday: null, date: isoDate('2026-12-25') })).toThrow(
      /for Fri Dec 25, 2026; change that one instead\.$/,
    );
  });

  it('lets a Christmas override sit beside the Friday floor it overrides', () => {
    const { west, save } = twoUnits();
    save({ weekday: 5 });
    save({ weekday: null, date: isoDate('2026-12-25') });
    expect(listCoverageRequirementsForUnit(handle.db, west.id)).toHaveLength(2);
  });

  it('refuses a minimum above the target', () => {
    const { west, save } = twoUnits();
    expect(() => save({ minCount: 5, targetCount: 4 })).toThrow(
      'The RN floor for Day 12 on Mondays has a minimum of 5 above its target of 4; raise the target or lower the minimum.',
    );
    expect(listCoverageRequirementsForUnit(handle.db, west.id)).toHaveLength(0);
  });

  it('refuses a floor for no day, and one for both a weekday and a date', () => {
    const { save } = twoUnits();
    expect(() => save({ weekday: null })).toThrow('Choose a weekday or a date for this floor.');
    expect(() => save({ weekday: 5, date: isoDate('2026-12-25') })).toThrow(
      'A floor is for a weekday or for one date, not both.',
    );
  });

  it("refuses another unit's shift type", () => {
    const { night, save } = twoUnits();
    expect(() => save({ shiftTypeId: night.id })).toThrow(
      'Night 12 is a shift on 5 East, not on 4 West.',
    );
  });

  it('refuses moving a floor to another unit through an update', () => {
    const { east, save, floor } = twoUnits();
    const made = save();
    expect(() =>
      upsertCoverageRequirement(handle.db, { ...floor(), id: made.id, unitId: east.id }, ACTOR),
    ).toThrow('A coverage floor cannot move to another unit.');
  });

  it('lets a floor be saved again unchanged, and refuses an edit that collides with another floor', () => {
    const { save, floor } = twoUnits();
    const monday = save();
    const tuesday = save({ weekday: 2 });
    expect(upsertCoverageRequirement(handle.db, { ...floor(), id: monday.id }, ACTOR)).toEqual(
      monday,
    );
    expect(() =>
      upsertCoverageRequirement(handle.db, { ...floor({ weekday: 1 }), id: tuesday.id }, ACTOR),
    ).toThrow('Day 12 already has an RN floor for Mondays; change that one instead.');
  });

  it('leaves the stored floor and the audit log alone when an edit is refused', () => {
    const { west, save, floor } = twoUnits();
    const monday = save();
    const auditBefore = recentAudit(handle.db, 1000).length;
    expect(() =>
      upsertCoverageRequirement(
        handle.db,
        { ...floor(), id: monday.id, minCount: 5, targetCount: 4 },
        ACTOR,
      ),
    ).toThrow(/minimum of 5 above its target of 4/);
    expect(listCoverageRequirementsForUnit(handle.db, west.id)).toEqual([monday]);
    expect(recentAudit(handle.db, 1000).length).toBe(auditBefore);
  });
});

describe('holiday attribution', () => {
  it('saves the unit’s holiday attribution and audits the change', () => {
    const unit = addUnit('4A Medicine-Surgery');
    transact(handle.db, (tx) => updateUnit(tx, unit.id, { holidayAttribution: 'clock' }, ACTOR));
    expect(getHomeUnit(handle.db)!.holidayAttribution).toBe('clock');
    const row = recentAudit(handle.db, 20).find((a) => a.entityType === 'unit');
    expect((row!.after as { holidayAttribution?: string }).holidayAttribution).toBe('clock');
    expect(
      (row!.before as { holidayAttribution?: string } | null)?.holidayAttribution,
    ).toBeUndefined();
  });

  it('clears the holiday attribution back to the start-date reading', () => {
    const unit = addUnit('4A Medicine-Surgery');
    transact(handle.db, (tx) => updateUnit(tx, unit.id, { holidayAttribution: 'majority' }, ACTOR));
    transact(handle.db, (tx) => updateUnit(tx, unit.id, { holidayAttribution: null }, ACTOR));
    expect(getHomeUnit(handle.db)!.holidayAttribution).toBeUndefined();
    const cleared = recentAudit(handle.db, 20).find((a) => a.entityType === 'unit');
    expect((cleared!.before as { holidayAttribution?: string }).holidayAttribution).toBe(
      'majority',
    );
  });

  it('refuses a holiday attribution it does not know', () => {
    const unit = addUnit('4A Medicine-Surgery');
    expect(() =>
      transact(handle.db, (tx) =>
        updateUnit(tx, unit.id, { holidayAttribution: 'weekly' as never }, ACTOR),
      ),
    ).toThrow(
      'Choose how a shift that crosses midnight counts toward a holiday: by the day it starts, by its hours on the holiday, or by the day holding most of it.',
    );
    expect(getHomeUnit(handle.db)!.holidayAttribution).toBeUndefined();
  });
});

describe('in-lieu holidays', () => {
  it('saves the federal in-lieu setting and audits the change', () => {
    const unit = addUnit('4A Medicine-Surgery');
    transact(handle.db, (tx) => updateUnit(tx, unit.id, { inLieuHolidays: 'federal' }, ACTOR));
    expect(getHomeUnit(handle.db)!.inLieuHolidays).toBe('federal');
    const row = recentAudit(handle.db, 20).find((a) => a.entityType === 'unit');
    expect((row!.after as { inLieuHolidays?: string }).inLieuHolidays).toBe('federal');
    expect((row!.before as { inLieuHolidays?: string } | null)?.inLieuHolidays).toBeUndefined();
  });

  it('clears the in-lieu setting back to holidays staying where they fall', () => {
    const unit = addUnit('4A Medicine-Surgery');
    transact(handle.db, (tx) => updateUnit(tx, unit.id, { inLieuHolidays: 'federal' }, ACTOR));
    transact(handle.db, (tx) => updateUnit(tx, unit.id, { inLieuHolidays: null }, ACTOR));
    expect(getHomeUnit(handle.db)!.inLieuHolidays).toBeUndefined();
    const cleared = recentAudit(handle.db, 20).find((a) => a.entityType === 'unit');
    expect((cleared!.before as { inLieuHolidays?: string }).inLieuHolidays).toBe('federal');
  });

  it('refuses an in-lieu setting it does not know', () => {
    const unit = addUnit('4A Medicine-Surgery');
    expect(() =>
      transact(handle.db, (tx) =>
        updateUnit(tx, unit.id, { inLieuHolidays: 'state' as never }, ACTOR),
      ),
    ).toThrow('In-lieu holidays must be “none” or “federal”.');
    expect(getHomeUnit(handle.db)!.inLieuHolidays).toBeUndefined();
  });
});

describe('paper size', () => {
  it('remembers that the unit prints on A4, and can go back to following the computer', () => {
    const unit = addUnit('4A Medicine-Surgery');
    transact(handle.db, (tx) => updateUnit(tx, unit.id, { paperSize: 'a4' }, ACTOR));
    expect(getHomeUnit(handle.db)!.paperSize).toBe('a4');
    const row = recentAudit(handle.db, 20).find((a) => a.entityType === 'unit');
    expect((row!.after as { paperSize?: string }).paperSize).toBe('a4');
    expect((row!.before as { paperSize?: string } | null)?.paperSize).toBeUndefined();

    transact(handle.db, (tx) => updateUnit(tx, unit.id, { paperSize: null }, ACTOR));
    expect(getHomeUnit(handle.db)!.paperSize).toBeUndefined();
    const cleared = recentAudit(handle.db, 20).find((a) => a.entityType === 'unit');
    expect((cleared!.before as { paperSize?: string }).paperSize).toBe('a4');
  });

  it('refuses a paper size it cannot print', () => {
    const unit = addUnit('4A Medicine-Surgery');
    expect(() =>
      transact(handle.db, (tx) =>
        updateUnit(tx, unit.id, { paperSize: 'legal' as PaperSize }, ACTOR),
      ),
    ).toThrow('Paper size must be Letter or A4.');
  });
});

describe('shift types that published schedules used', () => {
  let unitId: Id;
  let nurseId: Id;
  let ruleSet: { id: Id; version: number };

  function addType(name: string, startTime: string, hours: number, isNight: boolean) {
    return createShiftType(
      handle.db,
      {
        unitId,
        name,
        abbreviation: name.slice(0, 3),
        startTime,
        durationHours: hours,
        isNight,
        isOnCall: false,
        color: '#ffffff',
        sortOrder: 1,
        active: true,
      },
      ACTOR,
    );
  }

  function addPeriod(name: string, startDate: string, endDate: string) {
    return createPeriod(
      handle.db,
      {
        unitId,
        name,
        startDate: isoDate(startDate),
        endDate: isoDate(endDate),
        ruleSetId: ruleSet.id,
        ruleSetVersion: ruleSet.version,
      },
      ACTOR,
    ).id;
  }

  const place = (periodId: Id, shiftTypeId: Id, date: string) =>
    createAssignment(handle.db, { periodId, nurseId, shiftTypeId, date: isoDate(date) }, ACTOR);

  const publish = (periodId: Id) =>
    transact(handle.db, (tx) => publishSchedule(tx, { periodId }, ACTOR));

  const edit = (id: Id, patch: Parameters<typeof updateShiftType>[2]) =>
    updateShiftType(handle.db, id, patch, ACTOR);

  beforeEach(() => {
    unitId = addUnit('4 West').id;
    ruleSet = transact(handle.db, (tx) =>
      saveRuleSet(
        tx,
        {
          unitId,
          name: 'Default',
          weekendDefinition: {
            startWeekday: 6,
            startMinute: 0,
            durationMinutes: 2880,
            mode: 'starts_within',
          },
          fairnessWeights: DEFAULT_FAIRNESS_WEIGHTS,
          configs: [],
        },
        ACTOR,
      ),
    );
    nurseId = createNurse(
      handle.db,
      {
        unitId,
        employeeId: 'E1',
        firstName: 'Ana',
        lastName: 'Nurse',
        role: 'RN',
        employmentType: 'full_time',
        fte: 1,
        contractedHoursPerPeriod: 72,
        seniorityDate: isoDate('2020-01-01'),
        isChargeEligible: true,
        isNovice: false,
        isFloatEligible: true,
        active: true,
      },
      ACTOR,
    ).id;
  });

  /** Night 12 on a period with Ana on it on 2026-10-05; optionally published. */
  function nightOnOctober(published: boolean) {
    const night = addType('Night 12', '19:00', 12, true);
    const periodId = addPeriod('October', '2026-10-04', '2026-10-17');
    place(periodId, night.id, '2026-10-05');
    if (published) publish(periodId);
    return { night, periodId };
  }

  it('refuses new paid hours on a night shift a published schedule used', () => {
    const { night } = nightOnOctober(true);
    const audits = auditHistoryFor(handle.db, 'shift_type', night.id).length;

    expect(() => edit(night.id, { durationHours: 8 })).toThrow(
      'Night 12 is on 1 published or archived schedule, so its paid hours cannot change: that schedule was judged and priced with it. Duplicate it as a new type instead.',
    );
    expect(
      listShiftTypesForUnit(handle.db, unitId).find((t) => t.id === night.id)!.durationHours,
    ).toBe(12);
    expect(auditHistoryFor(handle.db, 'shift_type', night.id)).toHaveLength(audits);
  });

  it('names every locked field the manager tried to change', () => {
    const { night } = nightOnOctober(true);

    let message = '';
    try {
      edit(night.id, { startTime: '18:00', isNight: false, isOnCall: true });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('its start time, night flag and on-call flag cannot change');
    expect(message).toContain('judged and priced with them');
  });

  it('lets a published night shift be renamed, recoloured and reordered', () => {
    const { night } = nightOnOctober(true);

    const after = edit(night.id, { name: 'Nights', color: '#000000', sortOrder: 5 });

    expect(after.name).toBe('Nights');
    expect(auditHistoryFor(handle.db, 'shift_type', night.id)[0]!.before).toMatchObject({
      name: 'Night 12',
    });
  });

  it('accepts a save that repeats the current hours', () => {
    const { night } = nightOnOctober(true);

    const after = edit(night.id, { durationHours: 12, startTime: '19:00', name: 'Nights' });

    expect(after.name).toBe('Nights');
  });

  it('lets a shift used only in drafts change its hours', () => {
    const { night } = nightOnOctober(false);

    expect(edit(night.id, { durationHours: 8 }).durationHours).toBe(8);
  });

  it('counts an archived schedule as history too', () => {
    const { night, periodId } = nightOnOctober(true);
    archivePeriod(handle.db, periodId, ACTOR, 'Closed pay period');

    expect(() => edit(night.id, { durationHours: 8 })).toThrow(
      /is on 1 published or archived schedule/,
    );
  });

  it('counts a shift removed after publishing, because the change log still names it', () => {
    const night = addType('Night 12', '19:00', 12, true);
    const day = addType('Day 12', '07:00', 12, false);
    const periodId = addPeriod('October', '2026-10-04', '2026-10-17');
    place(periodId, night.id, '2026-10-05');
    place(periodId, day.id, '2026-10-07');
    publish(periodId);

    const gone = listAssignmentsForPeriod(handle.db, periodId).find(
      (a) => a.shiftTypeId === night.id,
    )!;
    deleteAssignment(handle.db, gone.id, ACTOR, 'Ana asked off');
    recordScheduleChange(
      handle.db,
      {
        periodId,
        kind: 'removed',
        assignmentId: gone.id,
        nurseId,
        date: gone.date,
        shiftTypeId: night.id,
        before: gone,
        reason: 'Ana asked off',
      },
      ACTOR,
    );

    expect(() => edit(night.id, { durationHours: 8 })).toThrow(
      /is on 1 published or archived schedule/,
    );
  });

  it('counts each schedule once however many shifts it holds', () => {
    const night = addType('Night 12', '19:00', 12, true);
    const first = addPeriod('October A', '2026-10-04', '2026-10-17');
    const second = addPeriod('October B', '2026-10-18', '2026-10-31');
    place(first, night.id, '2026-10-05');
    place(first, night.id, '2026-10-06');
    place(first, night.id, '2026-10-07');
    place(second, night.id, '2026-10-19');
    publish(first);
    publish(second);

    let message = '';
    try {
      edit(night.id, { durationHours: 8 });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('is on 2 published or archived schedules');
    expect(message).toContain('those schedules were');
  });

  it('lists the shift types whose timing is locked', () => {
    const day = addType('Day 12', '07:00', 12, false);
    const night = addType('Night 12', '19:00', 12, true);
    addType('Mid 8', '11:00', 8, false);
    const published = addPeriod('October A', '2026-10-04', '2026-10-17');
    const draft = addPeriod('October B', '2026-10-18', '2026-10-31');
    place(published, day.id, '2026-10-05');
    place(draft, night.id, '2026-10-19');
    publish(published);

    expect(lockedShiftTypeIds(handle.db, unitId)).toEqual([day.id]);
  });
});

describe('duplicating a shift type as a new one', () => {
  let unitId: Id;
  let ruleSet: { id: Id; version: number };

  function addNurse(employeeId: string, firstName: string, homeUnitId = unitId): Id {
    return createNurse(
      handle.db,
      {
        unitId: homeUnitId,
        employeeId,
        firstName,
        lastName: 'Nurse',
        role: 'RN',
        employmentType: 'full_time',
        fte: 1,
        contractedHoursPerPeriod: 72,
        seniorityDate: isoDate('2020-01-01'),
        isChargeEligible: true,
        isNovice: false,
        isFloatEligible: true,
        active: true,
      },
      ACTOR,
    ).id;
  }

  function addPeriod(name: string, startDate: string, endDate: string): Id {
    return createPeriod(
      handle.db,
      {
        unitId,
        name,
        startDate: isoDate(startDate),
        endDate: isoDate(endDate),
        ruleSetId: ruleSet.id,
        ruleSetVersion: ruleSet.version,
      },
      ACTOR,
    ).id;
  }

  const forecast = (shiftTypeId: Id, date: string) =>
    upsertCensusForecast(
      handle.db,
      {
        unitId,
        date: isoDate(date),
        shiftTypeId,
        projectedCensus: 20,
        acuityMix: {},
        source: 'manual',
      },
      ACTOR,
    );

  /**
   * 4 West: Night 12 published on 2026-10-05 for Ana, with a Monday RN floor, a BLS requirement,
   * two forecasts, Ana's wish for it, Late 4 inside it, and Ben on it in the November draft.
   * `lateHistory` also publishes a Late 4 shift for Cara on 2026-10-06.
   */
  function setup(lateHistory = false) {
    unitId = addUnit('4 West').id;
    ruleSet = transact(handle.db, (tx) =>
      saveRuleSet(
        tx,
        {
          unitId,
          name: 'Default',
          weekendDefinition: {
            startWeekday: 6,
            startMinute: 0,
            durationMinutes: 2880,
            mode: 'starts_within',
          },
          fairnessWeights: DEFAULT_FAIRNESS_WEIGHTS,
          configs: [],
        },
        ACTOR,
      ),
    );
    const ana = addNurse('E1', 'Ana');
    const ben = addNurse('E2', 'Ben');
    const cara = addNurse('E3', 'Cara');
    // Dee's home is 5 East; she floats to 4 West and has said she would rather not do its nights.
    const dee = addNurse('E4', 'Dee', addUnit('5 East').id);
    const night = createShiftType(
      handle.db,
      {
        unitId,
        name: 'Night 12',
        abbreviation: 'N12',
        startTime: '19:00',
        durationHours: 12,
        isNight: true,
        isOnCall: false,
        color: '#334455',
        sortOrder: 2,
        active: true,
      },
      ACTOR,
    );
    const late = createShiftType(
      handle.db,
      {
        unitId,
        name: 'Late 4',
        abbreviation: 'L4',
        startTime: '23:00',
        durationHours: 4,
        isNight: true,
        isOnCall: false,
        color: '#556677',
        sortOrder: 3,
        active: true,
        withinShiftTypeId: night.id,
      },
      ACTOR,
    );
    upsertCoverageRequirement(
      handle.db,
      {
        unitId,
        shiftTypeId: night.id,
        weekday: 1,
        date: null,
        role: 'RN',
        minCount: 3,
        targetCount: 4,
      },
      ACTOR,
    );
    const bls = createCredential(
      handle.db,
      { code: 'BLS', name: 'Basic Life Support', tracksExpiry: true },
      ACTOR,
    );
    createShiftCredentialRequirement(
      handle.db,
      { unitId, shiftTypeId: night.id, role: 'RN', credentialId: bls.id, minCount: 1 },
      ACTOR,
    );
    forecast(night.id, '2026-10-05');
    forecast(night.id, '2026-11-10');
    transact(handle.db, (tx) =>
      replaceNursePreferences(
        tx,
        ana,
        [
          {
            id: 'pref_ana_night' as Id,
            nurseId: ana,
            kind: 'prefer_shift_type',
            shiftTypeId: night.id,
            weight: 1,
          },
        ],
        ACTOR,
      ),
    );
    transact(handle.db, (tx) =>
      replaceNursePreferences(
        tx,
        dee,
        [
          {
            id: 'pref_dee_night' as Id,
            nurseId: dee,
            kind: 'avoid_shift_type',
            shiftTypeId: night.id,
            weight: 3,
          },
        ],
        ACTOR,
      ),
    );
    const october = addPeriod('October', '2026-10-04', '2026-10-17');
    createAssignment(
      handle.db,
      { periodId: october, nurseId: ana, shiftTypeId: night.id, date: isoDate('2026-10-05') },
      ACTOR,
    );
    if (lateHistory) {
      createAssignment(
        handle.db,
        { periodId: october, nurseId: cara, shiftTypeId: late.id, date: isoDate('2026-10-06') },
        ACTOR,
      );
    }
    transact(handle.db, (tx) => publishSchedule(tx, { periodId: october }, ACTOR));
    const november = addPeriod('November', '2026-11-01', '2026-11-14');
    createAssignment(
      handle.db,
      { periodId: november, nurseId: ben, shiftTypeId: night.id, date: isoDate('2026-11-03') },
      ACTOR,
    );
    return { ana, dee, night, late, bls };
  }

  const duplicate = (id: Id, changes: Parameters<typeof duplicateShiftType>[2]) =>
    transact(handle.db, (tx) => duplicateShiftType(tx, id, changes, ACTOR));

  const typeNamed = (name: string) =>
    listShiftTypesForUnit(handle.db, unitId).find((t) => t.name === name);

  it('makes an 8-hour night that keeps the 12-hour night’s floors, credentials and wishes', () => {
    const { ana, dee, night, late, bls } = setup();

    const result = duplicate(night.id, { name: 'Night 8', abbreviation: 'N8', durationHours: 8 });

    const n8 = result.shiftType;
    expect(n8).toMatchObject({
      name: 'Night 8',
      abbreviation: 'N8',
      startTime: '19:00',
      durationHours: 8,
      isNight: true,
      isOnCall: false,
      active: true,
    });
    expect(result.retired.id).toBe(night.id);
    expect(result.retired.active).toBe(false);
    expect(typeNamed('Night 12')!.active).toBe(false);

    const floors = listCoverageRequirementsForUnit(handle.db, unitId).filter(
      (r) => r.shiftTypeId === n8.id,
    );
    expect(floors).toHaveLength(1);
    expect(floors[0]).toMatchObject({ role: 'RN', weekday: 1, minCount: 3, targetCount: 4 });
    const creds = listShiftCredentialRequirementsForUnit(handle.db, unitId).filter(
      (r) => r.shiftTypeId === n8.id,
    );
    expect(creds).toHaveLength(1);
    expect(creds[0]).toMatchObject({ role: 'RN', credentialId: bls.id, minCount: 1 });
    expect(
      auditHistoryFor(handle.db, 'coverage_requirement', floors[0]!.id).map((a) => a.action),
    ).toEqual(['create']);
    expect(
      auditHistoryFor(handle.db, 'shift_credential_requirement', creds[0]!.id).map((a) => a.action),
    ).toEqual(['create']);

    const wishes = listPreferencesForNurse(handle.db, ana)
      .map((p) => (p.kind === 'prefer_shift_type' ? `${p.shiftTypeId}:${p.weight}` : p.kind))
      .sort();
    expect(wishes).toEqual([`${n8.id}:1`, `${night.id}:1`].sort());
    const [anaAudit] = auditHistoryFor(handle.db, 'preference', ana);
    expect(anaAudit!.action).toBe('update');
    expect((anaAudit!.before as { shiftTypeId: Id }[]).map((p) => p.shiftTypeId)).toEqual([
      night.id,
    ]);
    expect((anaAudit!.after as { shiftTypeId: Id }[]).map((p) => p.shiftTypeId).sort()).toEqual(
      [n8.id, night.id].sort(),
    );

    // Dee is not on 4 West's roster, but her wish names its night, so it follows the night.
    const deeWishes = listPreferencesForNurse(handle.db, dee)
      .map((p) => (p.kind === 'avoid_shift_type' ? `${p.shiftTypeId}:${p.weight}` : p.kind))
      .sort();
    expect(deeWishes).toEqual([`${n8.id}:3`, `${night.id}:3`].sort());

    // Night 8 runs 19:00–03:00 and Late 4 runs 23:00–03:00; half-open windows, so it fits.
    expect(typeNamed('Late 4')!.withinShiftTypeId).toBe(n8.id);
    expect(late.withinShiftTypeId).toBe(night.id);
    expect(result.stillInsideOld).toEqual([]);
    // Ben's 2026-11-03 night in the November draft.
    expect(result.draftShiftsOnOld).toBe(1);
  });

  it('moves future census forecasts to the new shift and leaves the published ones', () => {
    const { night } = setup();

    const { shiftType: n8 } = duplicate(night.id, { name: 'Night 8', durationHours: 8 });

    const byDate = new Map(listCensusHistory(handle.db, unitId).map((f) => [f.date, f]));
    expect(byDate.get(isoDate('2026-11-10'))!.shiftTypeId).toBe(n8.id);
    expect(byDate.get(isoDate('2026-10-05'))!.shiftTypeId).toBe(night.id);
    const moved = recentAudit(handle.db, 1000).filter(
      (a) => a.entityType === 'census_forecast' && a.action === 'update',
    );
    expect(moved).toHaveLength(1);
    expect((moved[0]!.before as { shiftTypeId: Id }).shiftTypeId).toBe(night.id);
    expect((moved[0]!.after as { shiftTypeId: Id }).shiftTypeId).toBe(n8.id);
  });

  it('leaves a mid shift with its own published history inside the old night, and says so', () => {
    const { night } = setup(true);

    const result = duplicate(night.id, { name: 'Night 8', durationHours: 8 });

    expect(typeNamed('Late 4')!.withinShiftTypeId).toBe(night.id);
    expect(result.stillInsideOld).toEqual(['Late 4']);
  });

  it('refuses a new night that a mid shift no longer fits inside, and changes nothing', () => {
    const { ana, night } = setup();
    const anaWishesBefore = listPreferencesForNurse(handle.db, ana);
    const floorsBefore = listCoverageRequirementsForUnit(handle.db, unitId).length;
    const auditBefore = recentAudit(handle.db, 1000).length;

    // Night 6 runs 19:00–01:00, which cannot hold Late 4's 23:00–03:00.
    expect(() =>
      duplicate(night.id, { name: 'Night 6', startTime: '19:00', durationHours: 6 }),
    ).toThrow(/Late 4 .*does not fit inside the hours of Night 6/);

    expect(typeNamed('Night 12')!.active).toBe(true);
    expect(typeNamed('Night 6')).toBeUndefined();
    expect(listCoverageRequirementsForUnit(handle.db, unitId)).toHaveLength(floorsBefore);
    expect(recentAudit(handle.db, 1000)).toHaveLength(auditBefore);
    // The forecast and the wish were rewritten before Late 4 was reached; both rolled back.
    const november10 = listCensusHistory(handle.db, unitId).find(
      (f) => f.date === isoDate('2026-11-10'),
    );
    expect(november10!.shiftTypeId).toBe(night.id);
    expect(listPreferencesForNurse(handle.db, ana)).toEqual(anaWishesBefore);
  });

  it('refuses a copy with the same name', () => {
    const { night } = setup();
    expect(() => duplicate(night.id, { name: ' night 12 ' })).toThrow(
      /Give the new shift type a different name from Night 12/,
    );
  });

  it('refuses to duplicate a retired shift', () => {
    const { night } = setup();
    deactivateShiftType(handle.db, night.id, ACTOR);
    expect(() => duplicate(night.id, { name: 'Night 8' })).toThrow(/already retired/);
  });
});
