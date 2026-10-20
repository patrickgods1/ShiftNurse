/**
 * Which unit the app opens. A VA install has a float sibling beside its home unit, and picking
 * "the unit" by alphabetical order once switched the whole app to the sibling the moment the
 * manager renamed the home unit so that it sorted second.
 */

import { type IsoDate, isoDate, type PaperSize, type Unit } from '@shiftnurse/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor, recentAudit } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { unit as unitTable } from '../schema.js';
import {
  createShiftType,
  createUnit,
  fillCoverageWeek,
  getHomeUnit,
  listCoverageRequirementsForUnit,
  listUnits,
  updateUnit,
  upsertCoverageRequirement,
} from './config.js';

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
