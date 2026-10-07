/**
 * Accommodations: a nurse's recurring window they cannot work. The reason is HR-sensitive, so
 * every write needs one and is audited with it.
 */

import { isoDate, type Nurse } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase } from '../client.js';
import {
  type AvailabilityBlockInput,
  createAvailabilityBlock,
  deleteAvailabilityBlock,
  listAvailabilityBlocks,
  updateAvailabilityBlock,
} from './availability-blocks.js';
import { createUnit } from './config.js';
import { nextEmployeeId } from './employee-ids.test-support.js';
import { createNurse } from './roster.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let vera: Nurse;
let nina: Nurse;
let stranger: Nurse;

function mkUnit(name: string) {
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

function mkNurse(forUnit: string, firstName: string): Nurse {
  return createNurse(
    handle.db,
    {
      unitId: forUnit,
      employeeId: nextEmployeeId(),
      firstName,
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

beforeEach(() => {
  handle = openTestDatabase();
  unitId = mkUnit('4 West').id;
  vera = mkNurse(unitId, 'Vera');
  nina = mkNurse(unitId, 'Nina');
  stranger = mkNurse(mkUnit('Other').id, 'Zed');
});
afterEach(() => handle.close());

function sabbath(nurse: Nurse, overrides: Partial<AvailabilityBlockInput> = {}) {
  return createAvailabilityBlock(
    handle.db,
    {
      unitId,
      nurseId: nurse.id,
      weekdays: [5],
      startTime: '18:00',
      endTime: '18:00',
      reason: 'Keeps the Sabbath',
      ...overrides,
    },
    ACTOR,
  );
}

describe('recording an accommodation', () => {
  it('stores it and audits the creation with the reason', () => {
    const block = sabbath(vera);
    expect(listAvailabilityBlocks(handle.db, unitId)).toEqual([block]);
    expect(auditHistoryFor(handle.db, 'availability_block', block.id)[0]).toMatchObject({
      action: 'create',
      reason: 'Keeps the Sabbath',
      after: { nurseId: vera.id, weekdays: [5], startTime: '18:00' },
    });
  });

  it('refuses a blank reason and writes nothing', () => {
    expect(() => sabbath(vera, { reason: '  ' })).toThrow(/Give a reason/);
    expect(listAvailabilityBlocks(handle.db, unitId)).toEqual([]);
  });

  it('refuses no days, repeated days and days that do not exist', () => {
    expect(() => sabbath(vera, { weekdays: [] })).toThrow(/at least one day/);
    expect(() => sabbath(vera, { weekdays: [5, 5] })).toThrow(/only once/);
    expect(() => sabbath(vera, { weekdays: [7 as 6] })).toThrow(/not a day of the week/);
  });

  it('refuses a time that is not HH:MM', () => {
    expect(() => sabbath(vera, { startTime: '6pm' })).toThrow(/Invalid time of day/);
    expect(() => sabbath(vera, { endTime: '25:00' })).toThrow(/Invalid time of day/);
  });

  it('refuses a block that ends before it starts', () => {
    expect(() =>
      sabbath(vera, { startsOn: isoDate('2026-11-01'), endsOn: isoDate('2026-10-01') }),
    ).toThrow(/ends before it starts/);
  });

  it('refuses a nurse from another unit', () => {
    expect(() => sabbath(stranger)).toThrow('That nurse is not on this unit');
  });

  it('keeps the days in week order', () => {
    expect(sabbath(vera, { weekdays: [6, 0, 5] }).weekdays).toEqual([0, 5, 6]);
  });
});

describe('changing an accommodation', () => {
  it('changes the window, records before and after, and takes the new reason', () => {
    const block = sabbath(vera);
    const after = updateAvailabilityBlock(
      handle.db,
      block.id,
      { startTime: '17:30', endTime: '18:30', reason: 'Sunset moved' },
      ACTOR,
    );
    expect(after).toMatchObject({ startTime: '17:30', endTime: '18:30', reason: 'Sunset moved' });
    expect(listAvailabilityBlocks(handle.db, unitId)).toEqual([after]);
    expect(auditHistoryFor(handle.db, 'availability_block', block.id)[0]).toMatchObject({
      action: 'update',
      reason: 'Sunset moved',
      before: { startTime: '18:00' },
      after: { startTime: '17:30' },
    });
  });

  it('clears a date with null', () => {
    const block = sabbath(vera, { endsOn: isoDate('2026-12-31') });
    const after = updateAvailabilityBlock(
      handle.db,
      block.id,
      { endsOn: null, reason: 'Now ongoing' },
      ACTOR,
    );
    expect(after.endsOn).toBeUndefined();
  });

  it('refuses a missing reason and a column it may not change', () => {
    const block = sabbath(vera);
    expect(() =>
      updateAvailabilityBlock(handle.db, block.id, { startTime: '17:00' }, ACTOR),
    ).toThrow(/Give a reason/);
    expect(() =>
      updateAvailabilityBlock(
        handle.db,
        block.id,
        { nurseId: nina.id, reason: 'x' } as never,
        ACTOR,
      ),
    ).toThrow(/cannot change 'nurseId'/);
    expect(listAvailabilityBlocks(handle.db, unitId)).toEqual([block]);
  });
});

describe('removing an accommodation', () => {
  it('removes it and audits what it was and why', () => {
    const block = sabbath(vera);
    deleteAvailabilityBlock(handle.db, block.id, 'Accommodation ended', ACTOR);
    expect(listAvailabilityBlocks(handle.db, unitId)).toEqual([]);
    expect(auditHistoryFor(handle.db, 'availability_block', block.id)[0]).toMatchObject({
      action: 'delete',
      reason: 'Accommodation ended',
      before: { id: block.id },
    });
  });

  it('refuses a blank reason and keeps the block', () => {
    const block = sabbath(vera);
    expect(() => deleteAvailabilityBlock(handle.db, block.id, ' ', ACTOR)).toThrow(/Give a reason/);
    expect(listAvailabilityBlocks(handle.db, unitId)).toEqual([block]);
  });
});
