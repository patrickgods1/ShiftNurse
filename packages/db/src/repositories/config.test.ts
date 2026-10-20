/**
 * Which unit the app opens. A VA install has a float sibling beside its home unit, and picking
 * "the unit" by alphabetical order once switched the whole app to the sibling the moment the
 * manager renamed the home unit so that it sorted second.
 */

import { isoDate, type Unit } from '@shiftnurse/core';
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
