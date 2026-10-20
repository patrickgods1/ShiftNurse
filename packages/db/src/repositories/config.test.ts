/**
 * Which unit the app opens. A VA install has a float sibling beside its home unit, and picking
 * "the unit" by alphabetical order once switched the whole app to the sibling the moment the
 * manager renamed the home unit so that it sorted second.
 */

import { isoDate, type Unit } from '@shiftnurse/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OpenedDatabase, openTestDatabase } from '../client.js';
import { unit as unitTable } from '../schema.js';
import { createUnit, getHomeUnit, listUnits, updateUnit } from './config.js';

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
