/**
 * Accommodations through the IPC handlers: each write lands with its audit row and reason, the
 * period's input carries the unit's blocks, and the grid flags a shift inside one without ever
 * saying why.
 */

import { addDays, type Weekday } from '@shiftnurse/core';
import { auditHistoryFor, getPeriod, loadPeriodInput } from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { availabilityBlocksApi } from './availability-blocks.js';
import { scheduleApi } from './schedule.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;
beforeEach(() => {
  f = openFixture();
});
afterEach(() => f.handle.close());

const api = () => availabilityBlocksApi(f.handle.db);
const day = (offset: number) => addDays(f.seeded.draftStart, offset);
const EVERY_DAY: Weekday[] = [0, 1, 2, 3, 4, 5, 6];
const REASON = 'Lactation schedule, PUMP Act';

/** Every day, all day: whatever the fixture's shifts are, they fall inside it. */
function block() {
  return {
    unitId: f.seeded.unitId,
    nurseId: f.rns[0]!.id,
    weekdays: EVERY_DAY,
    startTime: '00:00',
    endTime: '00:00',
    reason: REASON,
  };
}

describe('recording an accommodation', () => {
  it('records it, audits it with the reason and lists it', () => {
    const record = api().create(block());
    expect(api().list(f.seeded.unitId)).toEqual([record]);
    expect(auditHistoryFor(f.handle.db, 'availability_block', record.id)[0]).toMatchObject({
      action: 'create',
      actor: 'manager',
      reason: REASON,
    });
  });

  it('refuses a blank reason and records nothing', () => {
    expect(() => api().create({ ...block(), reason: ' ' })).toThrow(/Give a reason/);
    expect(api().list(f.seeded.unitId)).toEqual([]);
  });

  it('changes it under a stated reason, keeping what it was', () => {
    const record = api().create(block());
    expect(() => api().update(record.id, { endTime: '06:00' }, '')).toThrow(/Give a reason/);
    const changed = api().update(record.id, { endTime: '06:00' }, 'Shortened after review');
    expect(changed).toMatchObject({ endTime: '06:00', reason: 'Shortened after review' });
    expect(auditHistoryFor(f.handle.db, 'availability_block', record.id)[0]).toMatchObject({
      action: 'update',
      before: { endTime: '00:00' },
    });
  });

  it('removes it under a stated reason', () => {
    const record = api().create(block());
    expect(() => api().remove(record.id, '')).toThrow(/Give a reason/);
    api().remove(record.id, 'Accommodation ended');
    expect(api().list(f.seeded.unitId)).toEqual([]);
  });

  it('puts the block in the period input Generate and conflicts read', () => {
    const record = api().create(block());
    const period = getPeriod(f.handle.db, f.seeded.draftPeriodId)!;
    expect(loadPeriodInput(f.handle.db, period).availabilityBlocks).toEqual([record]);
  });
});

describe('the grid with a shift inside an accommodation', () => {
  it('flags it, names the nurse and never the reason', () => {
    api().create(block());
    scheduleApi(f.handle.db).createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: f.rns[0]!.id,
      shiftTypeId: f.day.id,
      date: day(3),
    });
    const found = scheduleApi(f.handle.db)
      .validate(f.seeded.draftPeriodId)
      .result.violations.filter((v) => v.code === 'works_during_accommodation');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'hard', nurseIds: [f.rns[0]!.id] });
    expect(JSON.stringify(found)).not.toMatch(/Lactation|PUMP/);
  });
});
