/**
 * Incompatible-staff groups: who may not be on the floor together. A group that saves with one
 * member, a nurse from another unit, or a cap that allows the whole group together would look
 * like protection and be none — so the repository refuses them, and every change is audited
 * with the manager's reason.
 */

import { isoDate, type Nurse } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { createUnit } from './config.js';
import {
  createIncompatibilityGroup,
  deleteIncompatibilityGroup,
  type IncompatibilityGroupInput,
  listIncompatibilityGroups,
  updateIncompatibilityGroup,
} from './incompatibility.js';
import { createNurse } from './roster.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let nurses: Nurse[];

function unit(name: string) {
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

function nurse(forUnit: string, n: number): Nurse {
  return createNurse(
    handle.db,
    {
      unitId: forUnit,
      employeeId: `E${forUnit}-${n}`,
      firstName: `Nurse${n}`,
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

function input(overrides: Partial<IncompatibilityGroupInput> = {}): IncompatibilityGroupInput {
  return {
    unitId,
    name: 'Keep apart',
    nurseIds: nurses.slice(0, 3).map((n) => n.id),
    maxTogether: 1,
    ...overrides,
  };
}

const create = (i: IncompatibilityGroupInput, reason = 'Open HR investigation') =>
  transact(handle.db, (tx) => createIncompatibilityGroup(tx, i, reason, ACTOR));

beforeEach(() => {
  handle = openTestDatabase();
  unitId = unit('4 West').id;
  nurses = [1, 2, 3, 4].map((n) => nurse(unitId, n));
});

afterEach(() => handle.close());

describe('incompatibility groups', () => {
  it('keeps a group of three with its members, cap and reason, and audits it', () => {
    const group = create(input());
    const [listed] = listIncompatibilityGroups(handle.db, unitId);
    expect(listed).toEqual(group);
    expect(listed!.nurseIds.sort()).toEqual(
      nurses
        .slice(0, 3)
        .map((n) => n.id)
        .sort(),
    );
    const history = auditHistoryFor(handle.db, 'incompatibility_group', group.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.reason).toBe('Open HR investigation');
  });

  it('refuses a change without a reason', () => {
    expect(() => create(input(), '  ')).toThrow(/requires a reason/);
    expect(listIncompatibilityGroups(handle.db, unitId)).toEqual([]);
  });

  it('refuses a group of one, or the same nurse twice', () => {
    expect(() => create(input({ nurseIds: [nurses[0]!.id] }))).toThrow(/two different nurses/);
    expect(() => create(input({ nurseIds: [nurses[0]!.id, nurses[0]!.id] }))).toThrow(
      /two different nurses/,
    );
  });

  it('refuses a cap that lets the whole group work together', () => {
    expect(() => create(input({ maxTogether: 3 }))).toThrow(/at most 2/);
    expect(() => create(input({ maxTogether: 0 }))).toThrow(/at least 1/i);
  });

  it('refuses a nurse from another unit', () => {
    const stranger = nurse(unit('5 East').id, 9);
    expect(() => create(input({ nurseIds: [nurses[0]!.id, stranger.id] }))).toThrow(
      /not on this unit/,
    );
  });

  it('refuses an end date before the start', () => {
    expect(() =>
      create(input({ startsOn: isoDate('2026-03-01'), endsOn: isoDate('2026-02-01') })),
    ).toThrow(/ends before it starts/);
  });

  it('replaces the members on update and keeps the before state in the audit', () => {
    const group = create(input());
    const updated = transact(handle.db, (tx) =>
      updateIncompatibilityGroup(
        tx,
        group.id,
        { nurseIds: [nurses[2]!.id, nurses[3]!.id], endsOn: isoDate('2026-06-30') },
        'Investigation closing in June',
        ACTOR,
      ),
    );
    expect(updated.nurseIds.sort()).toEqual([nurses[2]!.id, nurses[3]!.id].sort());
    expect(updated.endsOn).toBe('2026-06-30');
    const [latest] = auditHistoryFor(handle.db, 'incompatibility_group', group.id);
    expect(latest!.action).toBe('update');
    expect((latest!.before as { nurseIds: string[] }).nurseIds).toHaveLength(3);
  });

  it('refuses an update that tries to move the group to another unit', () => {
    const group = create(input());
    expect(() =>
      transact(handle.db, (tx) =>
        updateIncompatibilityGroup(tx, group.id, { unitId: 'x' } as never, 'why', ACTOR),
      ),
    ).toThrow(/cannot change 'unitId'/);
  });

  it('deletes with a reason, members and all', () => {
    const group = create(input());
    transact(handle.db, (tx) => deleteIncompatibilityGroup(tx, group.id, 'Resolved', ACTOR));
    expect(listIncompatibilityGroups(handle.db, unitId)).toEqual([]);
    expect(auditHistoryFor(handle.db, 'incompatibility_group', group.id)[0]!.action).toBe('delete');
  });
});
